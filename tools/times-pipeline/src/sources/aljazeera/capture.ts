import { load } from "cheerio";
import type { CapturedHtmlPage } from "../../capture/http.js";
import { BROWSER_USER_AGENT } from "../../network/headers.js";

const APOLLO_STATE_ASSIGNMENT = /window\.__APOLLO_STATE__\s*=\s*["']([A-Za-z0-9+/=_-]+)["']/u;
const MAX_LIVEBLOG_UPDATES = 250;
const GRAPHQL_BATCH_SIZE = 8;

export const AL_JAZEERA_LIVEBLOG_COMPLETE_ATTRIBUTE = "data-jojo-aljazeera-liveblog-complete";
export const AL_JAZEERA_LIVEBLOG_UPDATE_ATTRIBUTE = "data-jojo-aljazeera-liveblog-update";

interface AlJazeeraLiveblogDescriptor {
  id: string;
  childIds: string[];
}

interface AlJazeeraLiveblogUpdate {
  id: string;
  link: string;
  postType: "liveblog-update";
  content: string;
  date: string;
  title: string;
  shouldDisplayTitle: boolean;
}

interface AlJazeeraGraphqlResponse {
  data?: { posts?: unknown };
  errors?: unknown[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identifier(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9]\d*$/u.test(value)) {
    const numeric = Number(value);
    if (Number.isSafeInteger(numeric) && String(numeric) === value) return value;
  }
  return undefined;
}

function normalizedPath(value: string, pageUrl: string): string | undefined {
  try {
    const path = new URL(value, pageUrl).pathname.replace(/\/+$/u, "");
    return path || "/";
  } catch {
    return undefined;
  }
}

function sameArticlePath(value: string, pageUrl: string): boolean {
  try {
    const candidate = new URL(value, pageUrl);
    const page = new URL(pageUrl);
    if (!isAlJazeeraUrl(candidate) || !isAlJazeeraUrl(page)) return false;
    return normalizedPath(candidate.toString(), pageUrl) === normalizedPath(pageUrl, pageUrl);
  } catch {
    return false;
  }
}

export function isAlJazeeraLiveblogUrl(value: string): boolean {
  try {
    return new URL(value).pathname.split("/").includes("liveblog");
  } catch {
    return false;
  }
}

function apolloState(html: string): Record<string, unknown> | undefined {
  const document = load(html);
  for (const script of document("script").toArray()) {
    const source = document(script).html() ?? "";
    const encoded = source.match(APOLLO_STATE_ASSIGNMENT)?.[1];
    if (!encoded) continue;
    try {
      const parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as unknown;
      if (record(parsed)) return parsed;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Resolve the publisher's complete live-blog boundary from its SSR Apollo
 * state. Both arrays are checked because the UI lazily requests only a subset
 * of `children`; `childrenMeta` is the independent publisher inventory that
 * lets us distinguish a complete capture from the initially rendered page.
 */
export function alJazeeraLiveblogDescriptor(
  html: string,
  pageUrl: string,
): AlJazeeraLiveblogDescriptor | undefined {
  const state = apolloState(html);
  if (!state) return undefined;
  const matches: AlJazeeraLiveblogDescriptor[] = [];
  for (const [key, value] of Object.entries(state)) {
    if (!record(value) || value.type !== "liveblog") continue;
    const id = identifier(value.id);
    const link = typeof value.link === "string" ? value.link : undefined;
    if (!id || key !== `Post:${id}` || !link || !sameArticlePath(link, pageUrl)) continue;
    if (!Array.isArray(value.children) || !Array.isArray(value.childrenMeta)) continue;
    if (!value.children.length || value.children.length > MAX_LIVEBLOG_UPDATES) continue;

    const childIds = value.children.map(identifier);
    const metaIds = value.childrenMeta.map((meta) => {
      if (!record(meta) || typeof meta.__ref !== "string") return undefined;
      return meta.__ref.match(/^ChildMeta:([1-9]\d*)$/u)?.[1];
    });
    if (childIds.some((childId) => !childId)
      || metaIds.some((childId) => !childId)
      || childIds.length !== metaIds.length
      || childIds.some((childId, index) => childId !== metaIds[index])
      || new Set(childIds).size !== childIds.length) continue;

    const completeIds = childIds as string[];
    const completeMetadata = completeIds.every((childId) => {
      const metadata = state[`ChildMeta:${childId}`];
      return record(metadata) && identifier(metadata.id) === childId;
    });
    if (completeMetadata) matches.push({ id, childIds: completeIds });
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

function liveblogUpdate(value: unknown, expectedId: string, pageUrl: string): AlJazeeraLiveblogUpdate | undefined {
  if (!record(value)) return undefined;
  const id = identifier(value.id);
  const link = typeof value.link === "string" ? value.link : undefined;
  const content = typeof value.content === "string" ? value.content : undefined;
  const date = typeof value.date === "string" ? value.date.trim() : "";
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const shouldDisplayTitle = value.shouldDisplayTitle;
  if (id !== expectedId
    || value.postType !== "liveblog-update"
    || !link
    || !sameArticlePath(link, pageUrl)
    || content === undefined
    || !date
    || typeof shouldDisplayTitle !== "boolean"
    || (shouldDisplayTitle && !title)) return undefined;
  return {
    id,
    link,
    postType: "liveblog-update",
    content,
    date,
    title,
    shouldDisplayTitle,
  };
}

function graphqlUrl(pageUrl: string, childId: string): string {
  const url = new URL("/graphql", pageUrl);
  url.search = new URLSearchParams({
    "wp-site": "aje",
    operationName: "LiveBlogUpdateQuery",
    variables: JSON.stringify({
      postID: Number(childId),
      postType: "liveblog-update",
      preview: "",
      isAmp: false,
    }),
    extensions: "{}",
  }).toString();
  return url.toString();
}

async function fetchLiveblogUpdate(
  childId: string,
  pageUrl: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<AlJazeeraLiveblogUpdate | undefined> {
  const response = await fetchImpl(graphqlUrl(pageUrl, childId), {
    headers: {
      accept: "application/json",
      origin: new URL(pageUrl).origin,
      referer: pageUrl,
      "user-agent": BROWSER_USER_AGENT,
      "wp-site": "aje",
    },
    signal,
  });
  if (!response.ok) return undefined;
  const payload = await response.json() as AlJazeeraGraphqlResponse;
  if (payload.errors?.length) return undefined;
  return liveblogUpdate(payload.data?.posts, childId, pageUrl);
}

async function fetchLiveblogUpdates(
  descriptor: AlJazeeraLiveblogDescriptor,
  pageUrl: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<AlJazeeraLiveblogUpdate[] | undefined> {
  const updates: AlJazeeraLiveblogUpdate[] = [];
  for (let index = 0; index < descriptor.childIds.length; index += GRAPHQL_BATCH_SIZE) {
    const batch = descriptor.childIds.slice(index, index + GRAPHQL_BATCH_SIZE);
    const captured = await Promise.all(batch.map((childId) => fetchLiveblogUpdate(childId, pageUrl, signal, fetchImpl)));
    if (captured.some((update) => !update)) return undefined;
    updates.push(...captured as AlJazeeraLiveblogUpdate[]);
  }
  return updates;
}

function renderLiveblogUpdate(update: AlJazeeraLiveblogUpdate): string {
  const heading = update.shouldDisplayTitle ? `<h2>${escapeHtml(update.title)}</h2>` : "";
  return [
    `<article data-component="live-blog-post" ${AL_JAZEERA_LIVEBLOG_UPDATE_ATTRIBUTE}="${update.id}">`,
    `<time datetime="${escapeAttribute(update.date)}"></time>`,
    `<div class="wysiwyg">${heading}${update.content}</div>`,
    "</article>",
  ].join("");
}

export function alJazeeraLiveblogHtml(
  html: string,
  pageUrl: string,
  descriptor: AlJazeeraLiveblogDescriptor,
  updates: AlJazeeraLiveblogUpdate[],
): string | undefined {
  if (updates.length !== descriptor.childIds.length
    || updates.some((update, index) => update.id !== descriptor.childIds[index])) return undefined;
  const document = load(html);
  const header = document("main .compact-featured-area").first();
  if (!header.length) return undefined;
  header.after([
    `<section class="jojo-aljazeera-liveblog-updates" ${AL_JAZEERA_LIVEBLOG_COMPLETE_ATTRIBUTE}="${descriptor.id}">`,
    updates.map(renderLiveblogUpdate).join(""),
    "</section>",
  ].join(""));
  return document.html();
}

function isAlJazeeraUrl(url: URL): boolean {
  return url.protocol === "https:" && ["aljazeera.com", "www.aljazeera.com"].includes(url.hostname);
}

function isHtmlDocument(value: string): boolean {
  return /^\s*(?:<!doctype\s+html\b|<html\b)/iu.test(value);
}

function terminalLiveblogRedirect(
  requestedUrl: string,
  finalUrl: string,
  status: number,
  capturedAt: string,
): CapturedHtmlPage {
  return {
    method: "direct",
    requestedUrl,
    finalUrl,
    status,
    capturedAt,
    error: "AlJazeeraLiveblogRedirectMismatch",
    browserFallback: "forbidden",
  };
}

export async function captureAlJazeeraPage(
  url: string,
  timeoutSeconds: number,
  fetchImpl: typeof fetch = fetch,
): Promise<CapturedHtmlPage | undefined> {
  const capturedAt = new Date().toISOString();
  try {
    const requestedUrl = new URL(url);
    if (!isAlJazeeraUrl(requestedUrl)) return undefined;
    const signal = AbortSignal.timeout(timeoutSeconds * 1_000);
    const response = await fetchImpl(requestedUrl, {
      redirect: "follow",
      headers: {
        accept: "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.9",
        "user-agent": BROWSER_USER_AGENT,
      },
      signal,
    });
    const finalUrl = response.url || requestedUrl.toString();
    const canonicalUrl = new URL(finalUrl);
    if (isAlJazeeraLiveblogUrl(requestedUrl.toString())
      && (!isAlJazeeraUrl(canonicalUrl)
        || !isAlJazeeraLiveblogUrl(finalUrl)
        || normalizedPath(requestedUrl.toString(), requestedUrl.toString())
          !== normalizedPath(finalUrl, finalUrl))) {
      try {
        await response.body?.cancel();
      } catch {
        // The terminal redirect decision must survive response cleanup errors.
      }
      return terminalLiveblogRedirect(url, finalUrl, response.status, capturedAt);
    }
    if (!isAlJazeeraUrl(canonicalUrl)) return undefined;
    if (!response.ok || !/(?:text\/html|application\/xhtml\+xml)/iu.test(response.headers.get("content-type") ?? "")) {
      return undefined;
    }
    const originalHtml = await response.text();
    if (!isHtmlDocument(originalHtml)) return undefined;

    const descriptor = alJazeeraLiveblogDescriptor(originalHtml, finalUrl);
    if (isAlJazeeraLiveblogUrl(finalUrl) && !descriptor) return undefined;
    let renderedHtml = originalHtml;
    if (descriptor) {
      const updates = await fetchLiveblogUpdates(descriptor, finalUrl, signal, fetchImpl);
      if (!updates) return undefined;
      const completeHtml = alJazeeraLiveblogHtml(originalHtml, finalUrl, descriptor, updates);
      if (!completeHtml) return undefined;
      renderedHtml = completeHtml;
    }
    return {
      method: "direct",
      requestedUrl: url,
      finalUrl,
      status: response.status,
      originalHtml,
      renderedHtml,
      capturedAt,
    };
  } catch {
    return undefined;
  }
}
