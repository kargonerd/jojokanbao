import { load } from "cheerio";
import { semanticHtmlBlocks, semanticParagraphs, type BodyQuality } from "../../content/paragraphs.js";

export type ScmpJsonObject = Record<string, unknown>;

function object(value: unknown): ScmpJsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ScmpJsonObject : undefined;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function scmpArticleData(html: string): ScmpJsonObject | undefined {
  const document = load(html);
  const script = document("#__NEXT_DATA__").text();
  if (!script) return undefined;
  try {
    const root = object(JSON.parse(script));
    const pageProps = object(object(root?.props)?.pageProps);
    const payload = object(pageProps?.payload);
    return object(object(object(payload?.json)?.data)?.article)
      ?? object(object(payload?.data)?.article);
  } catch {
    return undefined;
  }
}

function renderInline(value: unknown): string {
  if (Array.isArray(value)) return value.map(renderInline).join("");
  const node = object(value);
  if (!node) return typeof value === "string" ? escapeHtml(value) : "";
  if (node.type === "text") return escapeHtml(string(node.data) ?? "");
  const children = renderInline(node.children);
  const type = string(node.type)?.toLowerCase();
  if (!type) return children;
  if (type === "br") return "<br>";
  if (["strong", "b", "em", "i", "u", "s", "sub", "sup", "code"].includes(type)) {
    return `<${type}>${children}</${type}>`;
  }
  if (type === "a") {
    const href = string(object(node.attribs)?.href);
    return href ? `<a href="${escapeHtml(href)}">${children}</a>` : children;
  }
  if (type === "li") return children.trim() ? `<li>${children}</li>` : "";
  if (type === "span") return children;
  return children;
}

export type ScmpBodyEntry =
  | { kind: "block"; html: string }
  | { kind: "image"; image: ScmpJsonObject };

function descendantImageEntries(value: unknown): ScmpBodyEntry[] {
  if (Array.isArray(value)) return value.flatMap(descendantImageEntries);
  const node = object(value);
  if (!node) return [];
  if (string(node.type)?.toLowerCase() === "img") return [{ kind: "image", image: node }];
  return descendantImageEntries(node.children);
}

function renderEntries(value: unknown): ScmpBodyEntry[] {
  if (Array.isArray(value)) return value.flatMap(renderEntries);
  const node = object(value);
  const type = string(node?.type)?.toLowerCase();
  if (!node || !type || [
    "inline-ad-slot",
    "inline-plus-widget",
    "track-viewed-percentage",
    "img",
    "video",
    "iframe",
  ].includes(type)) {
    return type === "img" && node ? [{ kind: "image", image: node }] : [];
  }
  if (["p", "h2", "h3", "h4", "blockquote", "pre", "ul", "ol", "li"].includes(type)) {
    const content = renderInline(node.children);
    return [
      ...(content.trim() ? [{ kind: "block" as const, html: `<${type}>${content}</${type}>` }] : []),
      ...descendantImageEntries(node.children),
    ];
  }
  return renderEntries(node.children);
}

function richText(value: unknown): { text?: string; json?: unknown[] } {
  const row = object(value);
  const text = string(row?.text);
  return {
    ...(text ? { text } : {}),
    ...(Array.isArray(row?.json) ? { json: row.json } : {}),
  };
}

export function scmpArticleBodyEntries(article: ScmpJsonObject): ScmpBodyEntry[] {
  const subHeadline = richText(article.subHeadline);
  const body = richText(article.body);
  return [
    ...(subHeadline.text
      ? [{ kind: "block" as const, html: `<h3>${escapeHtml(subHeadline.text)}</h3>` }]
      : []),
    ...(body.json ? renderEntries(body.json) : []),
  ];
}

export function extractScmpBody(html: string, quality: BodyQuality, pageUrl?: string): string | undefined {
  const article = scmpArticleData(html);
  if (!article) return undefined;
  const subHeadline = richText(article.subHeadline);
  const body = richText(article.body);
  const blocks = scmpArticleBodyEntries(article)
    .filter((entry): entry is Extract<ScmpBodyEntry, { kind: "block" }> => entry.kind === "block")
    .map((entry) => entry.html);
  const semantic = semanticHtmlBlocks(blocks, quality, pageUrl);
  if (semantic) return semantic;
  if (!body.text) return undefined;
  const values = [subHeadline.text, ...body.text.split(/\r?\n+/u)].filter((row): row is string => Boolean(row?.trim()));
  return semanticParagraphs(values, quality);
}
