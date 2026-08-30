import { load } from "cheerio";
import { semanticHtmlBlocks, type BodyQuality } from "../../content/paragraphs.js";

export type BloombergObject = Record<string, unknown>;

export function bloombergObject(value: unknown): BloombergObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as BloombergObject : undefined;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function safeHref(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const href = value.trim();
  if (!href) return undefined;
  try {
    const url = new URL(href);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : undefined;
  } catch {
    try {
      const resolved = new URL(href, "https://bloomberg.invalid/");
      return ["http:", "https:"].includes(resolved.protocol) ? href : undefined;
    } catch {
      return undefined;
    }
  }
}

function linkUrl(row: BloombergObject): string | undefined {
  const data = bloombergObject(row.data);
  const nestedLink = bloombergObject(data?.link);
  const destination = bloombergObject((nestedLink ?? data)?.destination);
  return [
    row.url,
    row.href,
    row.webUrl,
    data?.webUrl,
    data?.["data-web-url"],
    nestedLink?.webUrl,
    nestedLink?.["data-web-url"],
    destination?.web,
    data?.href,
    nestedLink?.href,
  ].map(safeHref).find(Boolean);
}

function nestedWebUrls(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(nestedWebUrls);
  const row = bloombergObject(value);
  if (!row) return [];
  const own = linkUrl(row);
  const nested = Object.values(row).flatMap(nestedWebUrls);
  return own ? [own, ...nested] : nested;
}

function richText(value: unknown): string {
  if (Array.isArray(value)) return value.map(richText).join("");
  const row = bloombergObject(value);
  if (!row) return "";
  if (row.type === "text" && typeof row.value === "string") {
    const attributes = bloombergObject(row.attributes);
    let text = escapeHtml(row.value);
    if (attributes?.strong === true) text = `<strong>${text}</strong>`;
    if (attributes?.italic === true || attributes?.emphasis === true) text = `<em>${text}</em>`;
    return text;
  }
  if (row.type === "linebreak" || row.type === "break") return "<br>";
  const content = richText(row.content);
  const href = linkUrl(row);
  if ((row.type === "link" || row.type === "entity") && href) return `<a href="${escapeHtml(href)}">${content}</a>`;
  return content;
}

function isPublisherPromotion(block: BloombergObject, text: string): boolean {
  if (/^sign up (?:here )?for .+ newsletter/iu.test(text) || /^subscribe to .+ podcast/iu.test(text)) return true;
  if (block.type === "list" && Array.isArray(block.content)) {
    const itemLinks = block.content.map(nestedWebUrls);
    return itemLinks.length > 0
      && itemLinks.every((urls) => urls.some((url) => url.includes("/account/newsletters/")));
  }
  return false;
}

/** Returns exactly one semantic HTML block for a Bloomberg body model row. */
export function bloombergBlockHtml(value: unknown): string | undefined {
  const block = bloombergObject(value);
  if (!block) return undefined;
  const text = richText(block.type === "text" ? block : block.content).trim();
  const plain = load(text, undefined, false).text().replaceAll(/\s+/gu, " ").trim();
  if (!plain || isPublisherPromotion(block, plain)) return undefined;
  if (block.type === "paragraph" || block.type === "text" || block.type === "div") return `<p>${text}</p>`;
  if (block.type === "header" || block.type === "heading") return `<h2>${text}</h2>`;
  if (block.type === "list" && Array.isArray(block.content)) {
    const items = block.content.map((entry) => `<li>${richText(bloombergObject(entry)?.content).trim()}</li>`)
      .filter((entry) => entry !== "<li></li>");
    if (!items.length) return undefined;
    const tag = block.subType === "ordered" ? "ol" : "ul";
    return `<${tag}>${items.join("")}</${tag}>`;
  }
  return undefined;
}

export function bloombergPageProps(html: string): BloombergObject | undefined {
  const document = load(html);
  const value = document("script#__NEXT_DATA__").text();
  if (!value) return undefined;
  try {
    const root = bloombergObject(JSON.parse(value));
    const props = bloombergObject(root?.props);
    const pageProps = bloombergObject(props?.pageProps);
    return pageProps;
  } catch {
    return undefined;
  }
}

export function bloombergStory(html: string): BloombergObject | undefined {
  return bloombergObject(bloombergPageProps(html)?.story);
}

export function extractBloombergBody(html: string, quality: BodyQuality, pageUrl?: string): string | undefined {
  const pageProps = bloombergPageProps(html);
  if (!pageProps) return undefined;
  const story = bloombergObject(pageProps.story);
  const body = bloombergObject(story?.body);
  const liveblog = bloombergObject(pageProps.liveblog);
  const posts = Array.isArray(liveblog?.posts) ? liveblog.posts : [];
  const blocks = [
    ...(Array.isArray(body?.content) ? body.content.flatMap((entry) => bloombergBlockHtml(entry) ?? []) : []),
    ...posts.flatMap((entry) => {
      const post = bloombergObject(entry);
      const postBody = bloombergObject(post?.body);
      return Array.isArray(postBody?.content) ? postBody.content.flatMap((block) => bloombergBlockHtml(block) ?? []) : [];
    }),
  ];
  return semanticHtmlBlocks(blocks, {
    minimumCharacters: quality.minimumCharacters ?? 250,
    minimumParagraphs: quality.minimumParagraphs ?? 2,
  }, pageUrl);
}
