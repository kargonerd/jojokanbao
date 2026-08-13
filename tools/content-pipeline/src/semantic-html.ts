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
  "blockquote", "ol", "ul", "li", "strong", "em", "sup", "sub", "u", "s", "q",
  "a", "br", "hr", "figure", "figcaption", "span",
];
const NON_VOID_SEMANTIC_TAGS = [
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "ol", "ul", "li",
  "strong", "em", "sup", "sub", "u", "s", "q", "a", "figure", "figcaption", "span",
].join("|");

const ALIGNABLE_TAGS = "p,h1,h2,h3,h4,h5,h6,blockquote,li,figure,figcaption";
const SEMANTIC_ALIGNMENTS = new Set(["left", "center", "right"]);
const NOTE_CLASSES = new Set(["content-k", "content-kt", "content-l"]);
const NOTE_DEFINITION_CLASS = /^(?:content[-_](?:k|kt|l)|fncontent(?:[-_].*)?)$/i;
const CAPTION_CLASSES = new Set(["imgtitle", "imgdescript", "tuti"]);
const IMAGE_CONTAINER_CLASS = /^(?:bodypic\d*|qrbodypic\d*|bodpic\d*|chatu_img\d*|pic)$/i;
const INLINE_IMAGE_CLASS = /^(?:h|s)-pic\d*$/i;
const FULL_WIDTH_IMAGE_CLASS = /^(?:qqreader-fullimg|bleed[-_]?pic\d*)$/i;
const TABLE_IMAGE_CLASS = /^(?:pic[-_]?table|table[-_]?pic)$/i;
const COVER_CLASS = /^frontcover$/i;
const SUBHEADING_CLASS = /^(?:title|subhead|content-title|content[-_]b)$/i;
const CENTER_CLASSES = /^(?:center|content[-_]?c\d*|contentcr\d*|newcontentcr\d*)$/i;
const RIGHT_CLASSES = /^(?:content[-_]?r|subhead)$/i;
const SHORT_ALIGNMENT_CLASS = /^(?:title|bodycontent(?:[-_]\d+)?)[-_]([clr])$/i;
const NO_INDENT_CLASS = /(?:^|[-_])noindent(?:$|[-_])|^content3(?:\d+|_\d+)?$|^content31$/i;
const POEM_CLASS = /(?:^|[-_])poem(?:$|[-_])|^poemcontent/i;
const SEMANTIC_ROLES = new Set([
  "annotation", "aside", "attribution", "caption", "cover", "full-width", "highlight",
  "image-container", "inline-image", "letter", "note", "poem", "salutation", "signature",
  "subheading", "table-image", "translation",
]);
const SEMANTIC_FONTS = new Set(["kai", "fang-song"]);
const SEMANTIC_SIZES = new Set(["small"]);
const SEMANTIC_BREAKS = new Set(["page"]);

type SemanticTag = "strong" | "em" | "sup" | "sub" | "u" | "s" | "q" | "blockquote" | "h4";

function sourceClasses(current: ReturnType<cheerio.CheerioAPI>): string[] {
  return (current.attr("class") ?? "").split(/\s+/).filter(Boolean);
}

function hasSourceClass(current: ReturnType<cheerio.CheerioAPI>, expected: Set<string>): boolean {
  return sourceClasses(current).some((className) => expected.has(className.toLowerCase()));
}

function renameElement(element: unknown, tagName: SemanticTag): void {
  const mutable = element as { name?: string; tagName?: string };
  mutable.name = tagName;
  mutable.tagName = tagName;
}

function semanticTag(classes: string[], currentTag: string): SemanticTag | undefined {
  const normalized = new Set(classes.map((className) => className.toLowerCase()));
  if (normalized.has("super")) return "sup";
  if (normalized.has("sub")) return "sub";
  if (normalized.has("bold") || normalized.has("wrtitlebold")) return "strong";
  if (normalized.has("italic")) return "em";
  if (normalized.has("underline")) return "u";
  if (normalized.has("linethrough") || normalized.has("strikethrough")) return "s";
  if (normalized.has("quotation-inline") && currentTag === "span") return "q";
  if ([...normalized].some((className) => /^quotation(?:-|$)/.test(className)) && currentTag === "p") return "blockquote";
  return undefined;
}

function semanticFont(classes: string[]): string | undefined {
  const normalized = classes.map((className) => className.toLowerCase());
  if (normalized.some((className) => (
    className.includes("kaiti")
    || className.startsWith("kt_")
    || NOTE_CLASSES.has(className)
    || className.startsWith("quotation")
    || className === "right-info"
    || className === "content-right"
  ))) return "kai";
  if (normalized.some((className) => className === "fangsong" || className.includes("fangsong"))) return "fang-song";
  return undefined;
}

function sourceImageWidth(current: ReturnType<cheerio.CheerioAPI>): string | undefined {
  const explicitWidth = Number(current.attr("data-width"));
  if (Number.isInteger(explicitWidth) && explicitWidth >= 10 && explicitWidth <= 100) return String(explicitWidth);
  for (const className of sourceClasses(current)) {
    const match = className.match(/^(?:width|pic-img-w)(\d{1,3})$/i);
    const width = match?.[1] ? Number(match[1]) : 0;
    if (width >= 10 && width <= 100) return String(width);
  }
  const inlineWidth = current.attr("style")?.match(/(?:^|;)\s*width\s*:\s*(\d{1,3})%/i)?.[1];
  const width = inlineWidth ? Number(inlineWidth) : 0;
  return width >= 10 && width <= 100 ? String(width) : undefined;
}

function unwrapInvalidBlockSpans($: cheerio.CheerioAPI): void {
  $("span").each((_index, element) => {
    const current = $(element);
    const blocks = current.find("p,h1,h2,h3,h4,h5,h6,blockquote,ol,ul,li,figure");
    if (!blocks.length) return;
    const leafTextBlocks = blocks.filter((_blockIndex, block) => (
      $(block).find("p,h1,h2,h3,h4,h5,h6,blockquote,ol,ul,li,figure").length === 0
    ));
    const classes = sourceClasses(current);
    const normalized = classes.map((className) => className.toLowerCase());
    const font = semanticFont(classes);
    if (font) blocks.attr("data-font", font);
    if (normalized.includes("quotation-inline")) blocks.filter("p").addClass("quotation");

    const wrapper = normalized.includes("bold") || normalized.includes("wrtitlebold")
      ? "strong"
      : normalized.includes("italic") ? "em"
        : normalized.includes("underline") ? "u"
          : normalized.includes("linethrough") ? "s" : undefined;
    if (wrapper) {
      leafTextBlocks.filter("p,h1,h2,h3,h4,h5,h6,li").each((_blockIndex, block) => {
        const target = $(block);
        target.html(`<${wrapper}>${target.html() ?? ""}</${wrapper}>`);
      });
    }
    current.replaceWith(current.contents());
  });
}

/**
 * Convert publisher-specific presentation hooks into a deliberately small,
 * source-independent vocabulary before arbitrary class/style attributes are
 * removed. The rules describe common book semantics rather than individual
 * titles, so WeRead HTML and EPUB XHTML pass through the same path.
 */
function preserveSourceSemantics($: cheerio.CheerioAPI): void {
  // EPUB commonly uses the older presentational spellings. JOJO keeps one
  // source-independent spelling for each meaning.
  $("b").each((_index, element) => renameElement(element, "strong"));
  $("i").each((_index, element) => renameElement(element, "em"));
  unwrapInvalidBlockSpans($);
  $("*").each((_index, element) => {
    const current = $(element);
    const classes = sourceClasses(current);
    const tagName = current.prop("tagName")?.toLowerCase() ?? "";
    const explicitRole = current.attr("data-role")?.toLowerCase();
    const explicitIndent = current.attr("data-indent")?.toLowerCase();
    const explicitFont = current.attr("data-font")?.toLowerCase();
    const explicitWidth = Number(current.attr("data-width"));
    const explicitSize = current.attr("data-size")?.toLowerCase();
    const explicitBreakBefore = current.attr("data-break-before")?.toLowerCase();
    current.removeAttr("data-role data-indent data-font data-width data-size data-break-before");
    if (explicitRole && SEMANTIC_ROLES.has(explicitRole)) current.attr("data-role", explicitRole);
    if (explicitIndent === "none") current.attr("data-indent", "none");
    if (explicitFont && SEMANTIC_FONTS.has(explicitFont)) current.attr("data-font", explicitFont);
    if (explicitSize && SEMANTIC_SIZES.has(explicitSize)) current.attr("data-size", explicitSize);
    if (explicitBreakBefore && SEMANTIC_BREAKS.has(explicitBreakBefore)) {
      current.attr("data-break-before", explicitBreakBefore);
    }
    if (Number.isInteger(explicitWidth) && explicitWidth >= 10 && explicitWidth <= 100) {
      current.attr("data-width", String(explicitWidth));
    }
    const replacement = semanticTag(classes, tagName);
    if (replacement) renameElement(element, replacement);

    const normalized = classes.map((className) => className.toLowerCase());
    if (normalized.some((className) => NOTE_DEFINITION_CLASS.test(className))) {
      current
        .attr("data-role", "note")
        .attr("data-indent", "none")
        // Internal import hint. It is intentionally absent from the final
        // semantic HTML allowlist.
        .attr("data-source-note-definition", "true");
    } else if (normalized.some((className) => CAPTION_CLASSES.has(className))) {
      current.attr("data-role", "caption").attr("data-indent", "none");
    } else if (normalized.some((className) => IMAGE_CONTAINER_CLASS.test(className))) {
      current.attr("data-role", "image-container");
    } else if (normalized.some((className) => COVER_CLASS.test(className))) {
      current.attr("data-role", "cover").attr("data-indent", "none");
    } else if (normalized.some((className) => FULL_WIDTH_IMAGE_CLASS.test(className))) {
      current.attr("data-role", "full-width").attr("data-indent", "none");
    } else if (normalized.some((className) => TABLE_IMAGE_CLASS.test(className))) {
      current.attr("data-role", "table-image").attr("data-indent", "none");
    } else if (normalized.some((className) => POEM_CLASS.test(className))) {
      current.attr("data-role", "poem").attr("data-indent", "none");
    } else if (normalized.includes("wr-translation")) {
      current.attr("data-role", "translation");
    } else if (normalized.some((className) => /^(?:border|bordered-box|textborder|bgcolor(?:-\d+)?)$/i.test(className))) {
      current.attr("data-role", tagName === "span" ? "highlight" : "aside");
      if (tagName === "div") renameElement(element, "blockquote");
    } else if (normalized.some((className) => SUBHEADING_CLASS.test(className))) {
      current.attr("data-role", "subheading").attr("data-indent", "none");
    } else if (normalized.includes("content-0")) {
      current.attr("data-role", "subheading").attr("data-align", "center").attr("data-indent", "none");
    } else if (normalized.includes("author")) {
      current.attr("data-role", "attribution").attr("data-align", "right").attr("data-indent", "none");
    } else if (normalized.includes("letters")) {
      current.attr("data-role", "salutation").attr("data-indent", "none");
    } else if (normalized.includes("text-letters")) {
      current.attr("data-role", "letter");
    } else if (normalized.includes("biaozhu")) {
      current.attr("data-role", "annotation").attr("data-indent", "none");
    }

    if (normalized.some((className) => NO_INDENT_CLASS.test(className))) current.attr("data-indent", "none");
    const font = semanticFont(classes);
    if (font) current.attr("data-font", font);
    if (normalized.some((className) => className === "small" || className === "xiao")) current.attr("data-size", "small");
    if (tagName.match(/^h[1-6]$/) && normalized.some((className) => className.toLowerCase().includes("underline"))) {
      current.html(`<u>${current.html() ?? ""}</u>`);
    }
    if (normalized.some((className) => /^signcontent(?:-|$)/.test(className))) current.attr("data-align", "right");
    if (normalized.includes("force-page-break")) current.attr("data-break-before", "page");
    const width = sourceImageWidth(current);
    if (width) current.attr("data-width", width);
    if (normalized.includes("signimg")) current.attr("data-role", "signature").attr("data-width", width ?? "30");
  });

  // A handful of exporters use an opaque `zh` hook for the literal notes
  // heading. The text check keeps this safe for unrelated books.
  $("p.zh").each((_index, element) => {
    if (/^(?:注释|註釋|notes?)$/i.test($(element).text().replace(/\s+/g, "").trim())) {
      renameElement(element, "h4");
      $(element).attr("data-role", "subheading").attr("data-indent", "none");
    }
  });
}

function semanticAlignment(current: ReturnType<cheerio.CheerioAPI>): string | undefined {
  const explicit = current.attr("data-align") ?? current.attr("align");
  if (explicit && SEMANTIC_ALIGNMENTS.has(explicit.toLowerCase())) return explicit.toLowerCase();

  const inline = current.attr("style")?.match(/(?:^|;)\s*text-align\s*:\s*(left|center|right)\b/i)?.[1];
  if (inline) return inline.toLowerCase();

  for (const className of (current.attr("class") ?? "").split(/\s+/)) {
    const match = className.toLowerCase().match(/(?:^|[-_])(left|center|right)(?:$|[-_])/);
    if (match?.[1]) return match[1];
    if (CENTER_CLASSES.test(className)) return "center";
    if (RIGHT_CLASSES.test(className)) return "right";
    const short = className.match(SHORT_ALIGNMENT_CLASS)?.[1]?.toLowerCase();
    if (short === "c") return "center";
    if (short === "l") return "left";
    if (short === "r") return "right";
  }
  return undefined;
}

function preserveSemanticAlignment($: cheerio.CheerioAPI): void {
  $("*").each((_index, element) => {
    const current = $(element);
    const alignment = current.is(ALIGNABLE_TAGS) ? semanticAlignment(current) : undefined;
    current.removeAttr("data-align");
    if (alignment) current.attr("data-align", alignment);
  });
}

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
  const lines = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  while (lines.at(-1)?.trim() === "") lines.pop();
  return lines
    .map((line) => line.trim())
    .map((line) => line
      ? `<p>${sanitizeHtml(line, { allowedTags: [], allowedAttributes: {} })}</p>`
      : "<p><br></p>")
    .join("");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function meaningfulImageLabel(value: string | undefined): string | null {
  const label = value?.replace(/\s+/g, " ").trim();
  if (!label || /^(?:image|img|picture|photo|cover|table|图片|图像|插图|封面|表格)$/i.test(label)) return null;
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
    const noteParagraph = $(element).attr("data-source-note-definition") === "true";
    const match = text.match(noteParagraph
      ? /^(\*+|\[(\d{1,3})\]|〔(\d{1,3})〕|\((\d{1,3})\)|（(\d{1,3})）)\s*(.+)$/s
      : /^(\*+|\[(\d{1,3})\]|〔(\d{1,3})〕)\s*(.+)$/s);
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
    const body = noteParagraph ? match[6] : match[4];
    if (!body) return;
    const cleanBody = body.trim();
    if (!cleanBody || /^[*＊\s—-]+$/.test(cleanBody)) return;
    const numericLabel = noteParagraph
      ? match[2] ?? match[3] ?? match[4] ?? match[5]
      : match[2] ?? match[3];
    definitions.push({
      element,
      label: numericLabel ?? match[1]!,
      body: cleanBody,
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
      const candidates = [
        `[${definition.label}]`,
        `〔${definition.label}〕`,
        `(${definition.label})`,
        `（${definition.label}）`,
      ];
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
        const existingSup = $(node as never).parent("sup");
        if (existingSup.length) {
          existingSup.attr("data-annotation-id", id).empty();
          markerPlaced = true;
          continue;
        }
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
  // Preserve only the small, interoperable part of source presentation that
  // carries meaning in books (for example a right-aligned date or signature).
  // Arbitrary classes and inline CSS are still removed by the sanitizer.
  preserveSourceSemantics($);
  preserveSemanticAlignment($);
  // Some exports put head-only elements directly in body. In XML mode an
  // empty <title/> later becomes an unclosed HTML RCDATA element and escapes
  // the remainder of the chapter, so remove it here as well as <head>.
  $("script,iframe,style,link,meta,title,head").remove();
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
    if (!current.parents().length) return;
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
    const sourceInline = sourceClasses(current).some((className) => INLINE_IMAGE_CLASS.test(className))
      || current.attr("style")?.toLowerCase().includes("vertical-align") === true;
    // A small image inside a note definition belongs to that annotation body.
    // Annotation assets are not modelled in v1, so keep its useful alt text
    // with the note rather than emitting an unreachable chapter asset.
    const noteContainer = current.closest('[data-role="note"]');
    if (noteContainer.length) {
      const fallback = meaningfulImageLabel(current.attr("alt"));
      current.replaceWith(fallback ? escapeText(fallback) : "");
      return;
    }
    const inline = sourceInline;
    const container = current.parents([
      '[data-role="image-container"]',
      '[data-role="signature"]',
      '[data-role="cover"]',
      '[data-role="full-width"]',
      '[data-role="table-image"]',
    ].join(", ")).first();
    const captionElement = container.length
      ? container.find('[data-role="caption"]').first()
      : current.parent().next('[data-role="caption"]').first();
    const caption = meaningfulImageLabel(captionElement.text()) ?? meaningfulImageLabel(current.attr("title"));
    const alt = meaningfulImageLabel(current.attr("alt")) ?? caption;
    const width = sourceImageWidth(current) ?? (container.length ? container.attr("data-width") : undefined);
    const presentationRole = current.attr("data-role") || container.attr("data-role") || "";
    const figureRole = presentationRole === "image-container" || presentationRole === "inline-image"
      ? ""
      : presentationRole;
    const role = inline
      ? "inline"
      : figureRole === "table-image" ? "table"
        : figureRole || "content";
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
        role,
        mediaType: mediaTypeFromUrl(sourceUrl),
        path: "",
        sourceUrl,
        size: 0,
        sha256: "",
        alt,
        caption,
      });
    }
    if (!resolvable) {
      current.replaceWith(alt ? `<span>${sanitizeHtml(alt, { allowedTags: [] })}</span>` : "");
      return;
    }
    if (inline) {
      current.replaceWith(`<span data-asset-id="${id}" data-role="inline-image"></span>`);
      return;
    }
    const figure = $(`<figure data-asset-id="${id}"></figure>`);
    if (width) figure.attr("data-width", width);
    if (figureRole) figure.attr("data-role", figureRole);
    const displayCaption = caption ?? (figureRole === "cover" ? null : alt);
    if (displayCaption) figure.append(`<figcaption>${sanitizeHtml(displayCaption, { allowedTags: [] })}</figcaption>`);
    if (container.length && container.find("img").length === 1) {
      // Replace the image at its own position, remove only the caption that
      // was promoted into figcaption, then unwrap the publisher container.
      // Some books put meaningful annotation paragraphs beside an image;
      // replacing the whole container would silently delete that prose.
      current.replaceWith(figure);
      captionElement.remove();
      container.replaceWith(container.contents());
      return;
    }
    captionElement.remove();
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
  // The Reader creates the interactive annotation link. Remove a source
  // anchor that only wrapped the old printed marker, otherwise rendering the
  // annotation would create invalid nested links.
  $("a").each((_index, element) => {
    const current = $(element);
    if (current.find("sup[data-annotation-id]").length && !current.text().trim()) {
      current.replaceWith(current.contents());
    }
  });

  // `span` is part of the profile solely for meaningful inline assets and
  // controlled typography. Unwrap arbitrary exporter spans as before.
  $("span").each((_index, element) => {
    const current = $(element);
    if (current.attr("data-asset-id") || current.attr("data-role") || current.attr("data-font") || current.attr("id")) return;
    current.replaceWith(current.contents());
  });
  $("sup > sup, sub > sub").each((_index, element) => {
    const current = $(element);
    const semanticId = current.attr("data-annotation-id");
    if (semanticId) current.parent().attr("data-annotation-id", semanticId).empty();
    else current.replaceWith(current.contents());
  });

  // WeRead may concatenate several valid XHTML files into one logical chapter.
  // Cheerio's `.html()` only returns the first match, so collect every body in
  // source order instead of silently dropping all later spine fragments.
  const bodies = $("body");
  const bodyHtml = bodies.length
    ? bodies.map((_index, body) => $(body).html() ?? "").get().join("\n")
    : $.root().html() ?? "";
  // XML serialization shortens any empty element to <tag/>. HTML only treats
  // true void elements that way; <figure/>, <p/>, <sup/> and friends would
  // otherwise swallow every following sibling until an accidental end tag.
  const htmlWithClosedElements = bodyHtml.replace(
    new RegExp(`<(${NON_VOID_SEMANTIC_TAGS})\\b([^>]*)\\/>`, "gi"),
    "<$1$2></$1>",
  );
  const value = sanitizeHtml(htmlWithClosedElements, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      "*": ["id", "data-align", "data-role", "data-indent", "data-font", "data-width", "data-size", "data-break-before"],
      a: ["href", "data-target-id", "data-anchor-id"],
      figure: ["data-asset-id"],
      span: ["data-asset-id"],
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
