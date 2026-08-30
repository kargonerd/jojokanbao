import { load } from "cheerio";
import type { CapturedHtmlPage } from "../../capture/http.js";
import { BROWSER_USER_AGENT } from "../../network/headers.js";

const NYT_CONFIG_URL = "https://www.nytimes.com/manifest.json";

const ARTICLE_QUERY = `
query ArticleQuery($id: String!) {
  article: workOrLocation(id: $id) {
    __typename
    ... on Article {
      id
      url
      headline { default }
      summary
      bylines {
        renderedRepresentation
        creators {
          __typename
          ... on Person { id displayName url bioUrl }
        }
      }
      body {
        content {
          __typename
          ... on HeaderBasicBlock {
            ledeMedia {
              __typename
              ... on ImageBlock {
                size
                media { __typename ... on Image { ...ImageFields } }
              }
            }
          }
          ... on ParagraphBlock {
            textAlign
            content {
              __typename
              ... on LineBreakInline { type }
              ... on TextInline {
                text
                formats {
                  __typename
                  ... on BoldFormat { type }
                  ... on ItalicFormat { type }
                  ... on LinkFormat { url title }
                }
              }
            }
          }
          ... on ImageBlock {
            size
            media { __typename ... on Image { ...ImageFields } }
          }
        }
      }
    }
  }
}
fragment ImageFields on Image {
  id
  imageType
  url
  uri
  credit
  legacyHtmlCaption
  altText
  caption { text }
  crops(renditionNames: ["articleLarge", "jumbo", "superJumbo", "popup", "mobileMasterAt3x"]) {
    name
    renditions { url name width height }
  }
}`;

interface NytGraphqlConfig {
  endpoint: string;
  headers: {
    "nyt-app-type": string;
    "nyt-app-version": string;
    "nyt-token": string;
  };
}

interface NytFormat {
  __typename?: string;
  url?: string;
  title?: string;
}

interface NytInline {
  __typename?: string;
  text?: string;
  formats?: NytFormat[];
}

interface NytRendition {
  url?: string;
  name?: string;
  width?: number;
  height?: number;
}

interface NytImage {
  __typename?: string;
  url?: string;
  uri?: string;
  credit?: string;
  legacyHtmlCaption?: string;
  altText?: string;
  caption?: { text?: string };
  crops?: Array<{ name?: string; renditions?: NytRendition[] }>;
}

interface NytImageBlock {
  __typename?: string;
  media?: NytImage;
}

interface NytBodyBlock {
  __typename?: string;
  content?: NytInline[];
  ledeMedia?: NytImageBlock;
  media?: NytImage;
}

interface NytArticle {
  __typename?: string;
  headline?: { default?: string };
  summary?: string;
  bylines?: Array<{
    creators?: Array<{
      __typename?: string;
      displayName?: string;
      url?: string;
      bioUrl?: string;
    }>;
  }>;
  body?: { content?: NytBodyBlock[] };
}

interface NytGraphqlResponse {
  data?: { article?: NytArticle | null };
  errors?: unknown[];
}

let configPromise: Promise<NytGraphqlConfig> | undefined;

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

function normalizedText(value: string | undefined): string | undefined {
  const text = value?.replaceAll(/\s+/gu, " ").trim();
  return text || undefined;
}

function safeUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, baseUrl);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function objectAfterKey(html: string, key: string, after = 0): Record<string, unknown> | undefined {
  const keyIndex = html.indexOf(`"${key}"`, after);
  if (keyIndex < 0) return undefined;
  const start = html.indexOf("{", keyIndex + key.length + 2);
  if (start < 0) return undefined;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, index + 1)) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function parseNytGraphqlConfig(html: string): NytGraphqlConfig | undefined {
  const preloaded = html.indexOf("window.__preloadedData");
  if (preloaded < 0) return undefined;
  const endpointKey = html.indexOf('"gqlUrlClient"', preloaded);
  const endpointStart = endpointKey < 0 ? -1 : html.indexOf('"', html.indexOf(":", endpointKey) + 1);
  let endpoint: string | undefined;
  if (endpointStart >= 0) {
    let escaped = false;
    for (let index = endpointStart + 1; index < html.length; index += 1) {
      const character = html[index]!;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') {
        try {
          endpoint = JSON.parse(html.slice(endpointStart, index + 1)) as string;
        } catch {
          endpoint = undefined;
        }
        break;
      }
    }
  }
  // The surrounding preloaded config contains JavaScript `undefined` values,
  // but these request headers are a standalone JSON object.
  const rawHeaders = objectAfterKey(html, "gqlRequestHeaders", preloaded);
  const appType = typeof rawHeaders?.["nyt-app-type"] === "string" ? rawHeaders["nyt-app-type"] : undefined;
  const appVersion = typeof rawHeaders?.["nyt-app-version"] === "string" ? rawHeaders["nyt-app-version"] : undefined;
  const token = typeof rawHeaders?.["nyt-token"] === "string" ? rawHeaders["nyt-token"] : undefined;
  if (!endpoint || !appType || !appVersion || !token) return undefined;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".nytimes.com")) return undefined;
  } catch {
    return undefined;
  }
  return {
    endpoint,
    headers: {
      "nyt-app-type": appType,
      "nyt-app-version": appVersion,
      "nyt-token": token,
    },
  };
}

async function loadGraphqlConfig(fetchImpl: typeof fetch, timeoutSeconds: number): Promise<NytGraphqlConfig> {
  const response = await fetchImpl(NYT_CONFIG_URL, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": BROWSER_USER_AGENT,
    },
    signal: AbortSignal.timeout(timeoutSeconds * 1_000),
  });
  const config = parseNytGraphqlConfig(await response.text());
  if (!config) throw new Error("NytGraphqlConfigNotFound");
  return config;
}

async function graphqlConfig(fetchImpl: typeof fetch, timeoutSeconds: number): Promise<NytGraphqlConfig> {
  configPromise ??= loadGraphqlConfig(fetchImpl, timeoutSeconds).catch((error: unknown) => {
    configPromise = undefined;
    throw error;
  });
  return configPromise;
}

function renderInline(inline: NytInline, pageUrl: string): string | undefined {
  if (inline.__typename === "LineBreakInline") return "<br>";
  if (inline.__typename !== "TextInline" || typeof inline.text !== "string") return undefined;
  let html = escapeHtml(inline.text);
  for (const format of inline.formats ?? []) {
    if (format.__typename === "BoldFormat") html = `<strong>${html}</strong>`;
    else if (format.__typename === "ItalicFormat") html = `<em>${html}</em>`;
    else if (format.__typename === "LinkFormat") {
      const href = safeUrl(format.url, pageUrl);
      if (href) html = `<a href="${escapeAttribute(href)}"${format.title ? ` title="${escapeAttribute(format.title)}"` : ""}>${html}</a>`;
    }
  }
  return html;
}

function renderParagraph(block: NytBodyBlock, pageUrl: string): string | undefined {
  const rendered = (block.content ?? []).map((inline) => renderInline(inline, pageUrl));
  if (!rendered.length || rendered.some((value) => value === undefined)) return undefined;
  const html = rendered.join("");
  return normalizedText(load(html, undefined, false).root().text()) ? `<p>${html}</p>` : undefined;
}

function imageRendition(image: NytImage, pageUrl: string): (NytRendition & { url: string }) | undefined {
  const priority = new Map([
    ["superJumbo", 5],
    ["jumbo", 4],
    ["articleLarge", 3],
    ["mobileMasterAt3x", 2],
    ["popup", 1],
  ]);
  const candidates = (image.crops ?? []).flatMap((crop) => (crop.renditions ?? []).map((rendition) => ({
    ...rendition,
    cropName: crop.name,
  }))).flatMap((rendition) => {
    const url = safeUrl(rendition.url, pageUrl);
    return url ? [{ ...rendition, url }] : [];
  });
  const selected = candidates.toSorted((left, right) => {
    const rightPriority = priority.get(right.name ?? right.cropName ?? "") ?? 0;
    const leftPriority = priority.get(left.name ?? left.cropName ?? "") ?? 0;
    return rightPriority - leftPriority || (right.width ?? 0) - (left.width ?? 0);
  })[0];
  if (selected) return selected;
  const url = safeUrl(image.url ?? image.uri, pageUrl);
  return url ? { url } : undefined;
}

function legacyCaptionText(value: string | undefined): string | undefined {
  return value ? normalizedText(load(value, undefined, false).root().text()) : undefined;
}

function renderImage(block: NytImageBlock | NytBodyBlock | undefined, pageUrl: string): string | undefined {
  if (!block || block.__typename !== "ImageBlock" || !block.media || block.media.__typename !== "Image") return undefined;
  const rendition = imageRendition(block.media, pageUrl);
  if (!rendition) return undefined;
  const alt = normalizedText(block.media.altText);
  const caption = normalizedText(block.media.caption?.text) ?? legacyCaptionText(block.media.legacyHtmlCaption);
  const credit = normalizedText(block.media.credit);
  const attributes = [
    `src="${escapeAttribute(rendition.url)}"`,
    alt ? `alt="${escapeAttribute(alt)}"` : 'alt=""',
    rendition.width && rendition.width > 0 ? `width="${rendition.width}"` : undefined,
    rendition.height && rendition.height > 0 ? `height="${rendition.height}"` : undefined,
  ].filter(Boolean).join(" ");
  const figcaption = caption || credit
    ? `<figcaption>${caption ? `<span>${escapeHtml(caption)}</span>` : ""}${credit ? `<span data-testid="image-credit">${escapeHtml(credit)}</span>` : ""}</figcaption>`
    : "";
  return `<figure><img ${attributes}>${figcaption}</figure>`;
}

function creatorLinks(article: NytArticle, pageUrl: string): Array<{ name: string; url: string }> {
  const values = new Map<string, { name: string; url: string }>();
  for (const byline of article.bylines ?? []) {
    for (const creator of byline.creators ?? []) {
      const name = normalizedText(creator.displayName);
      const url = safeUrl(creator.url ?? creator.bioUrl, pageUrl);
      if (creator.__typename === "Person" && name && url) {
        values.set(`${name}\n${url}`, { name, url });
      }
    }
  }
  return [...values.values()];
}

export function nytGraphqlArticleHtml(payload: NytGraphqlResponse, pageUrl: string): string | undefined {
  if (payload.errors?.length) return undefined;
  const article = payload.data?.article;
  if (!article || article.__typename !== "Article") return undefined;
  const headline = normalizedText(article.headline?.default);
  const blocks = article.body?.content;
  if (!headline || !blocks?.length) return undefined;

  const story: string[] = [];
  let lead = "";
  for (const block of blocks) {
    if (block.__typename === "HeaderBasicBlock") {
      const image = renderImage(block.ledeMedia, pageUrl);
      if (image) lead ||= image;
    } else if (block.__typename === "ParagraphBlock") {
      const paragraph = renderParagraph(block, pageUrl);
      if (!paragraph) return undefined;
      story.push(paragraph);
    } else if (block.__typename === "ImageBlock") {
      const image = renderImage(block, pageUrl);
      if (!image) return undefined;
      story.push(image);
    } else if (block.__typename?.toLowerCase().includes("video")) {
      continue;
    } else {
      return undefined;
    }
  }
  if (!story.some((block) => block.startsWith("<p>"))) return undefined;

  const summary = normalizedText(article.summary);
  const byline = creatorLinks(article, pageUrl);
  const storyText = normalizedText(load(story.join(""), undefined, false).root().text()) ?? "";
  // The live Person.description is a mutable profile, not an article snapshot.
  // Preserve the article-specific creator link without importing that drifting
  // biography when no authored footer is present in body.content.
  const authorAttribution = byline.length && !byline.some((creator) => storyText.includes(creator.name))
    ? `<p data-testid="article-author">By ${byline.map((creator) => `<a href="${escapeAttribute(creator.url)}">${escapeHtml(creator.name)}</a>`).join(", ")}</p>`
    : "";
  return [
    "<!doctype html><html><head>",
    `<meta name="description" content="${escapeAttribute(summary ?? "")}">`,
    "</head><body><main><article>",
    `<h1>${escapeHtml(headline)}</h1>`,
    summary ? `<p id="article-summary">${escapeHtml(summary)}</p>` : "",
    byline.length ? `<p data-testid="byline">By ${byline.map((creator) => `<a href="${escapeAttribute(creator.url)}">${escapeHtml(creator.name)}</a>`).join(", ")}</p>` : "",
    lead,
    `<section name="articleBody">${story.join("")}${authorAttribution}</section>`,
    "</article></main></body></html>",
  ].join("");
}

export async function captureNytGraphqlPage(
  url: string,
  timeoutSeconds: number,
  fetchImpl: typeof fetch = fetch,
): Promise<CapturedHtmlPage | undefined> {
  const capturedAt = new Date().toISOString();
  try {
    const canonical = new URL(url);
    if (canonical.hostname !== "www.nytimes.com") return undefined;
    const config = await graphqlConfig(fetchImpl, timeoutSeconds);
    const response = await fetchImpl(config.endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        origin: "https://www.nytimes.com",
        referer: canonical.toString(),
        "user-agent": BROWSER_USER_AGENT,
        ...config.headers,
      },
      body: JSON.stringify({
        operationName: "ArticleQuery",
        variables: { id: canonical.pathname },
        query: ARTICLE_QUERY,
      }),
      signal: AbortSignal.timeout(timeoutSeconds * 1_000),
    });
    if (!response.ok) return undefined;
    const html = nytGraphqlArticleHtml(await response.json() as NytGraphqlResponse, canonical.toString());
    if (!html) return undefined;
    return {
      method: "direct",
      requestedUrl: url,
      finalUrl: canonical.toString(),
      status: response.status,
      renderedHtml: html,
      capturedAt,
    };
  } catch {
    return undefined;
  }
}

export function resetNytGraphqlConfigCacheForTests(): void {
  configPromise = undefined;
}
