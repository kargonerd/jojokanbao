import { load } from "cheerio";
import { semanticParagraphs, type BodyQuality } from "../../content/paragraphs.js";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function richText(value: unknown): string {
  if (Array.isArray(value)) return value.map(richText).join("");
  const row = object(value);
  if (!row) return "";
  if (row.type === "text" && typeof row.value === "string") return row.value;
  return richText(row.content);
}

const ignoredBlockTypes = new Set(["ad", "embed", "inline-newsletter", "inline-recirc", "media", "tabularData"]);

function contentParagraphs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const block = object(entry);
    if (!block || (typeof block.type === "string" && ignoredBlockTypes.has(block.type))) return [];
    const text = richText(block).trim();
    return text ? [text] : [];
  });
}

export function extractBloombergBody(html: string, quality: BodyQuality): string | undefined {
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
    return semanticParagraphs([
      ...contentParagraphs(body?.content),
      ...liveblogParagraphs,
    ], embeddedBodyQuality);
  } catch {
    return undefined;
  }
}
