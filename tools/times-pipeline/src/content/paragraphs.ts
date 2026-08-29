import { load } from "cheerio";

export interface BodyQuality {
  minimumCharacters?: number;
  minimumParagraphs?: number;
}

const ACCESS_BOILERPLATE = [
  "thank you for your patience while we verify access",
  "subscribe to continue",
  "sign in to continue",
  "register to continue",
  "already a subscriber",
  "want all of the times? subscribe",
];

const SAFE_ELEMENTS = new Set([
  "a", "blockquote", "br", "code", "em", "h2", "h3", "h4", "i", "li",
  "ol", "p", "pre", "s", "strong", "sub", "sup", "u", "ul", "b",
]);

const CONTENT_ELEMENTS = new Set(["blockquote", "li", "p", "pre"]);

function safeHref(value: string | undefined, baseUrl?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = baseUrl ? new URL(value, baseUrl) : new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeBlock(value: string, baseUrl?: string): { html: string; text: string; contentBlocks: number } | undefined {
  const fragment = load(value, undefined, false);
  fragment("script,style,noscript,iframe,form,svg,canvas,video,audio,button,input,textarea,select").remove();
  for (const element of fragment("*").toArray().reverse()) {
    const node = fragment(element);
    if (!("tagName" in element)) continue;
    const tag = element.tagName.toLowerCase();
    if (!SAFE_ELEMENTS.has(tag)) {
      node.replaceWith(node.contents());
      continue;
    }
    const href = tag === "a" ? safeHref(node.attr("href"), baseUrl) : undefined;
    for (const name of Object.keys(element.attribs)) node.removeAttr(name);
    if (href) node.attr({ href, target: "_blank", rel: "noopener noreferrer" });
    else if (tag === "a") node.replaceWith(node.contents());
  }
  const text = fragment.root().text().replaceAll(/\s+/gu, " ").trim();
  if (!text || ACCESS_BOILERPLATE.some((hint) => text.toLowerCase().includes(hint))) return undefined;
  const rootElements = fragment.root().children().toArray();
  const rootIsContent = rootElements.some((element) => "tagName" in element && CONTENT_ELEMENTS.has(element.tagName.toLowerCase()));
  if (rootIsContent && text.length < 20) return undefined;
  let html = fragment.html().trim();
  let contentBlocks = rootElements.filter((element) => "tagName" in element && CONTENT_ELEMENTS.has(element.tagName.toLowerCase())).length;
  if (!rootElements.length || rootElements.every((element) => !("tagName" in element) || !SAFE_ELEMENTS.has(element.tagName.toLowerCase()))) {
    html = `<p>${escapeHtml(text)}</p>`;
    contentBlocks = 1;
  }
  return { html, text, contentBlocks };
}

export function semanticHtmlBlocks(
  values: string[],
  quality: BodyQuality = {},
  baseUrl?: string,
): string | undefined {
  const seen = new Set<string>();
  const blocks = values
    .map((value) => sanitizeBlock(value, baseUrl))
    .filter((value): value is NonNullable<typeof value> => Boolean(value))
    .filter((value) => !seen.has(value.text) && Boolean(seen.add(value.text)));
  const textLength = blocks.reduce((sum, block) => sum + block.text.length, 0);
  const contentBlocks = blocks.reduce((sum, block) => sum + block.contentBlocks, 0);
  if (textLength < (quality.minimumCharacters ?? 800) || contentBlocks < (quality.minimumParagraphs ?? 3)) return undefined;
  return blocks.map((block) => block.html).join("");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function semanticParagraphs(
  values: string[],
  quality: BodyQuality = {},
): string | undefined {
  const seen = new Set<string>();
  const paragraphs = values.map((value) => value.replaceAll(/\s+/gu, " ").trim())
    .filter((value) => value.length >= 20 && !ACCESS_BOILERPLATE.some((hint) => value.toLowerCase().includes(hint)))
    .filter((value) => !seen.has(value) && Boolean(seen.add(value)));
  const text = paragraphs.join("\n");
  if (text.length < (quality.minimumCharacters ?? 800) || paragraphs.length < (quality.minimumParagraphs ?? 3)) return undefined;
  return paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("");
}
