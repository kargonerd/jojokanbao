import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import sanitizeHtml from "sanitize-html";
import type {
  JojoAnnotation,
  JojoCanonicalAsset,
  JojoCanonicalChapter,
} from "@jojo/content";
import type { DecodedWereadChapter, PipelineDiagnostic } from "./models";

const ALLOWED_TAGS = [
  "p", "h1", "h2", "h3", "h4", "h5", "h6",
  "blockquote", "ol", "ul", "li", "strong", "em", "sup", "sub",
  "a", "br", "hr", "figure", "figcaption",
];

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function mediaTypeFromUrl(url: string): string {
  const dataType = url.match(/^data:([^;,]+)/i)?.[1];
  if (dataType) return dataType.toLowerCase();
  const pathname = new URL(url, "https://relative.invalid/").pathname.toLowerCase();
  if (pathname.endsWith(".png")) return "image/png";
  if (pathname.endsWith(".webp")) return "image/webp";
  if (pathname.endsWith(".gif")) return "image/gif";
  if (pathname.endsWith(".svg")) return "image/svg+xml";
  return "image/jpeg";
}

function plainText(value: string): string {
  return sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, " ")
    .trim();
}

function textBody(content: string): string {
  return content
    .split(/\r?\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${sanitizeHtml(paragraph, { allowedTags: [], allowedAttributes: {} })}</p>`)
    .join("");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function meaningfulImageLabel(value: string | undefined): string | null {
  const label = value?.replace(/\s+/g, " ").trim();
  if (!label || /^(?:image|img|picture|photo|图片|图像|插图)$/i.test(label)) return null;
  return label;
}

interface TextNodeLike {
  type: "text";
  data: string;
}

function textualAnnotations(
  $: cheerio.CheerioAPI,
  source: DecodedWereadChapter,
  diagnostics: PipelineDiagnostic[],
): JojoAnnotation[] {
  const definitions: Array<{
    element: object;
    label: string;
    body: string;
    numeric: boolean;
    prefix?: string;
  }> = [];
  $("p").each((_index, element) => {
    const text = $(element).text().replace(/\s+/g, " ").trim();
    const match = text.match(/^(\*+|\[(\d{1,3})\]|〔(\d{1,3})〕)\s*(.+)$/s);
    if (!match) {
      const inlineStar = text.match(/^(.+?)\*+\s*(这是.+)$/s);
      if (inlineStar) {
        definitions.push({
          element,
          label: "*",
          body: inlineStar[2]!.trim(),
          numeric: false,
          prefix: inlineStar[1]!.trim(),
        });
      }
      return;
    }
    const body = match[4]!.trim();
    if (!body || /^[*＊\s—-]+$/.test(body)) return;
    const numericLabel = match[2] ?? match[3];
    definitions.push({
      element,
      label: numericLabel ?? match[1]!,
      body,
      numeric: Boolean(numericLabel),
    });
  });
  if (definitions.length === 0) return [];

  const definitionElements = new Set(definitions.map((definition) => definition.element));
  const collectTextNodes = (): {
    textNodes: Array<{ node: TextNodeLike; order: number }>;
    nodeOrder: Map<object, number>;
  } => {
    const textNodes: Array<{ node: TextNodeLike; order: number }> = [];
    const nodeOrder = new Map<object, number>();
    let traversalOrder = 0;
    const visit = (node: unknown, insideDefinition = false): void => {
      if (!node || typeof node !== "object") return;
      nodeOrder.set(node, traversalOrder++);
      const value = node as { type?: string; data?: string; children?: unknown[] };
      const excluded = insideDefinition || definitionElements.has(node);
      if (value.type === "text" && typeof value.data === "string" && !excluded) {
        textNodes.push({ node: value as TextNodeLike, order: nodeOrder.get(node)! });
      }
      for (const child of value.children ?? []) visit(child, excluded);
    };
    visit($.root()[0]);
    return { textNodes, nodeOrder };
  };

  const annotations: JojoAnnotation[] = [];
  let unresolvedDefinitions = 0;
  for (const [index, definition] of definitions.entries()) {
    const id = `annotation:${shortHash(`${source.id}:text:${index}:${definition.label}:${definition.body}`)}`;
    let markerPlaced = false;
    if (definition.numeric) {
      const { textNodes, nodeOrder } = collectTextNodes();
      const candidates = [`[${definition.label}]`, `〔${definition.label}〕`];
      for (let nodeIndex = textNodes.length - 1; nodeIndex >= 0 && !markerPlaced; nodeIndex -= 1) {
        const candidateNode = textNodes[nodeIndex]!;
        if (candidateNode.order >= (nodeOrder.get(definition.element) ?? Number.POSITIVE_INFINITY)) continue;
        const node = candidateNode.node;
        let marker = "";
        let position = -1;
        for (const candidate of candidates) {
          const found = node.data.lastIndexOf(candidate);
          if (found > position) {
            marker = candidate;
            position = found;
          }
        }
        if (position < 0) continue;
        const before = node.data.slice(0, position);
        const after = node.data.slice(position + marker.length);
        $(node as never).replaceWith(`${escapeText(before)}<sup data-annotation-id="${id}"></sup>${escapeText(after)}`);
        markerPlaced = true;
      }
    } else {
      if (definition.prefix) {
        $(definition.element as never).html(`${escapeText(definition.prefix)}<sup data-annotation-id="${id}"></sup>`);
        markerPlaced = true;
      } else {
        const previous = $(definition.element as never).prevAll("h1,h2,h3,h4,h5,h6,p").first();
        if (previous.length) {
          previous.append(`<sup data-annotation-id="${id}"></sup>`);
          markerPlaced = true;
        }
      }
    }
    if (!markerPlaced) {
      unresolvedDefinitions += 1;
      continue;
    }
    if (!definition.prefix) $(definition.element as never).remove();
    annotations.push({
      id,
      targetId: source.id,
      kind: definition.numeric ? "footnote" : "editor-note",
      label: definition.label,
      body: { format: "text", value: definition.body },
    });
  }
  const remaining = $.root().text();
  if (unresolvedDefinitions > 0 || /\*\s*(?:\[\d{1,3}\]|〔\d{1,3}〕)|(?:\[\d{1,3}\]|〔\d{1,3}〕)\s*(?:\[\d{1,3}\]|〔\d{1,3}〕)/.test(remaining)) {
    diagnostics.push({
      level: "warning",
      code: "unresolved-text-footnote-markers",
      message: `${source.title}：仍有无法可靠配对的纯文本注号，已原样保留`,
      source: source.sourceFiles[0],
    });
  }
  return annotations;
}

export interface SemanticChapterResult {
  chapter: JojoCanonicalChapter;
  annotations: JojoAnnotation[];
  assets: JojoCanonicalAsset[];
  characterCount: number;
}

export function convertWereadChapter(
  source: DecodedWereadChapter,
  diagnostics: PipelineDiagnostic[],
): SemanticChapterResult {
  const input = source.contentType === "text/plain"
    ? `<html><body>${textBody(source.content)}</body></html>`
    : source.content;
  const $ = cheerio.load(input, { xmlMode: true });
  $("script,iframe,style,link,meta,head").remove();
  const annotations: JojoAnnotation[] = [];
  const assets = new Map<string, JojoCanonicalAsset>();
  let numberedAnnotationCount = 0;
  let titleAnnotationCount = 0;

  let annotationSourceIndex = 0;
  $(
    "h1.chapterTitle,h2.chapterTitle,h3.chapterTitle,h4.chapterTitle,h5.chapterTitle,h6.chapterTitle,"
    + "[data-wr-footernote],img.qqreader-footnote",
  ).each((_index, element) => {
    const current = $(element);
    if (current.is("h1,h2,h3,h4,h5,h6")) {
      numberedAnnotationCount = 0;
      titleAnnotationCount = 0;
      return;
    }
    const index = annotationSourceIndex++;
    const note = String(
      current.attr("data-wr-footernote")
      || current.attr("alt")
      || current.text()
      || "",
    ).replace(/\s+/g, " ").trim();
    if (!note) {
      current.remove();
      return;
    }
    const heading = current.closest("h1,h2,h3,h4,h5,h6");
    const headingText = heading.clone()
      .find("[data-wr-footernote], img.qqreader-footnote")
      .remove()
      .end()
      .text()
      .replace(/\s+/g, " ")
      .trim();
    const isTitleAnnotation = heading.length > 0 && (
      heading.hasClass("chapterTitle")
      || headingText.normalize("NFKC") === source.title.normalize("NFKC").trim()
    );
    const explicitLabel = current.attr("data-jojo-footnote-label")?.trim();
    const label = explicitLabel || (isTitleAnnotation
      ? "*".repeat(++titleAnnotationCount)
      : String(++numberedAnnotationCount));
    const id = `annotation:${shortHash(`${source.id}:${index}:${note}`)}`;
    annotations.push({
      id,
      targetId: source.id,
      kind: "footnote",
      label,
      body: { format: "text", value: note },
    });
    // Some WeRead XHTML exports serialize an img marker as a non-void element
    // and accidentally nest the following prose inside it. Keep that prose
    // after the semantic marker instead of deleting it with the source node.
    const trailingContent = current.html() ?? "";
    if (trailingContent) current.after(trailingContent);
    current.replaceWith(`<sup data-annotation-id="${id}"></sup>`);
  });

  annotations.push(...textualAnnotations($, source, diagnostics));

  $("img").each((_index, element) => {
    const current = $(element);
    const sourceUrl = current.attr("src")?.trim();
    if (!sourceUrl) {
      current.remove();
      return;
    }
    if (/^(?:\.\.\/)?Images\/note\.png$/i.test(sourceUrl)) {
      current.remove();
      return;
    }
    const id = `asset:image-${shortHash(sourceUrl)}`;
    const alt = meaningfulImageLabel(current.attr("alt"));
    const resolvable = /^(?:https:\/\/|data:)/i.test(sourceUrl);
    if (!resolvable) {
      diagnostics.push({
        level: "warning",
        code: "unresolved-relative-asset",
        message: `章节 ${source.title} 引用了未随 JSON 导出的资源 ${sourceUrl}`,
        source: sourceUrl,
      });
    } else if (!assets.has(id)) {
      assets.set(id, {
        id,
        type: "image",
        role: "content",
        mediaType: mediaTypeFromUrl(sourceUrl),
        path: "",
        sourceUrl,
        size: 0,
        sha256: "",
        alt,
        caption: alt,
      });
    }
    if (!resolvable) {
      current.replaceWith(alt ? `<p>${sanitizeHtml(alt, { allowedTags: [] })}</p>` : "");
      return;
    }
    const figure = $(`<figure data-asset-id="${id}"></figure>`);
    if (alt) figure.append(`<figcaption>${sanitizeHtml(alt, { allowedTags: [] })}</figcaption>`);
    const parent = current.parent();
    if (parent.is("p") && parent.children().length === 1 && !parent.text().trim()) parent.replaceWith(figure);
    else current.replaceWith(figure);
  });

  $("audio,video").each((_index, element) => {
    const current = $(element);
    const sourceUrl = current.attr("src")?.trim() || current.find("source[src]").first().attr("src")?.trim();
    if (!sourceUrl || !/^(?:https:\/\/|data:)/i.test(sourceUrl)) {
      current.remove();
      return;
    }
    const type = current.is("audio") ? "audio" : "video";
    const id = `asset:${type}-${shortHash(sourceUrl)}`;
    const caption = current.attr("title")?.trim() || current.attr("aria-label")?.trim() || null;
    assets.set(id, {
      id,
      type,
      role: "content",
      mediaType: mediaTypeFromUrl(sourceUrl),
      path: "",
      sourceUrl,
      size: 0,
      sha256: "",
      alt: caption,
      caption,
    });
    current.replaceWith(`<figure data-asset-id="${id}">${caption ? `<figcaption>${escapeText(caption)}</figcaption>` : ""}</figure>`);
  });

  $("a[href]").each((_index, element) => {
    const current = $(element);
    const href = current.attr("href")?.trim() ?? "";
    if (href && !/^(?:#|https?:|mailto:)/i.test(href)) current.replaceWith(current.contents());
  });

  const bodyHtml = $("body").length ? $("body").html() ?? "" : $.root().html() ?? "";
  // XML serialization shortens an empty semantic marker to <sup/>. HTML
  // parsers treat that as an opening tag and swallow the following prose.
  const htmlWithClosedMarkers = bodyHtml.replace(
    /<sup\b([^>]*data-annotation-id="[^"]+"[^>]*)\/>/g,
    "<sup$1></sup>",
  );
  const value = sanitizeHtml(htmlWithClosedMarkers, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      "*": ["id"],
      a: ["href"],
      figure: ["data-asset-id"],
      sup: ["data-annotation-id"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
  }).trim();

  return {
    chapter: {
      id: source.id,
      order: source.order,
      title: source.title,
      body: { format: "html", profile: "jojo-semantic-html/1", value },
      assetRefs: [...assets.keys()],
    },
    annotations,
    assets: [...assets.values()],
    characterCount: plainText(value).length,
  };
}

export function htmlToText(value: string): string {
  return cheerio.load(value).text().replace(/\s+/g, " ").trim();
}
