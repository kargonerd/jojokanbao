import { load } from "cheerio";
import { semanticHtmlBlocks, type BodyQuality } from "../../content/paragraphs.js";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function richText(value: unknown): string {
  if (Array.isArray(value)) return value.map(richText).join("");
  const row = object(value);
  if (!row) return "";
  if (row.type === "text" && typeof row.value === "string") return escapeHtml(row.value);
  const content = richText(row.content);
  if (row.type === "link") {
    const href = [row.url, row.href, row.webUrl].find((candidate): candidate is string => typeof candidate === "string");
    return href ? `<a href="${escapeHtml(href)}">${content}</a>` : content;
  }
  return content;
}

const ignoredBlockTypes = new Set(["ad", "embed", "inline-newsletter", "inline-recirc", "media", "tabularData"]);

function contentParagraphs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const block = object(entry);
    if (!block || (typeof block.type === "string" && ignoredBlockTypes.has(block.type))) return [];
    const text = richText(block).trim();
    if (!text) return [];
    return [block.type === "header" || block.type === "heading" ? `<h2>${text}</h2>` : `<p>${text}</p>`];
  });
}

export function extractBloombergBody(html: string, quality: BodyQuality, pageUrl?: string): string | undefined {
  const document = load(html);
  const value = document("script#__NEXT_DATA__").text();
  if (!value) return undefined;
  try {
    const root = object(JSON.parse(value));
    const props = object(root?.props);
    const pageProps = object(props?.pageProps);
    const story = object(pageProps?.story);
    const body = object(story?.body);
    const liveblog = object(pageProps?.liveblog);
    const posts = Array.isArray(liveblog?.posts) ? liveblog.posts : [];
    const liveblogParagraphs = posts.flatMap((entry) => {
      const post = object(entry);
      return contentParagraphs(object(post?.body)?.content);
    });
    const embeddedBodyQuality = {
      minimumCharacters: quality.minimumCharacters ?? 250,
      minimumParagraphs: quality.minimumParagraphs ?? 2,
    };
    return semanticHtmlBlocks([
      ...contentParagraphs(body?.content),
      ...liveblogParagraphs,
    ], embeddedBodyQuality, pageUrl);
  } catch {
    return undefined;
  }
}
