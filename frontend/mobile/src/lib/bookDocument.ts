import type { JojoFragment } from "@jojo/content";
import { DomUtils, parseDocument } from "htmlparser2";
import type { BookReadingMode } from "./bookReaderBridge";
import type { BookPaperColor } from "../store/mobileStore";

interface BookDocumentOptions {
  fragment: JojoFragment;
  assetUrls: Record<string, string>;
  textScale: number;
  lineHeight: number;
  firstLineIndent: boolean;
  eInk: boolean;
  readingMode: BookReadingMode;
  paperColor: BookPaperColor;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeBody(fragment: JojoFragment): string {
  const source = fragment.body.format === "html"
    ? fragment.body.value
    : fragment.body.value
      .split(/\n{2,}/)
      .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br>")}</p>`)
      .join("");
  return source
    .replace(/<(script|style|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\/?(?:script|style|iframe|object|embed|link|meta)\b[^>]*>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+(?:href|src)\s*=\s*(["'])\s*javascript:[\s\S]*?\1/gi, "");
}

function insertAssets(html: string, assetUrls: Record<string, string>): string {
  let result = html;
  for (const [assetId, url] of Object.entries(assetUrls)) {
    const escapedId = assetId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const placeholder = new RegExp(`(<(?:figure|span)\\b[^>]*data-asset-id=["']${escapedId}["'][^>]*>)`, "gi");
    result = result.replace(placeholder, `$1<img src="${escapeHtml(url)}" alt="">`);
  }
  return result;
}

function hasDuplicateLeadingTitle(html: string, title: string): boolean {
  const heading = /^\s*<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/i.exec(html);
  if (!heading) return false;
  const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/g, "");
  const nodes = parseDocument(heading[2]!).children;
  const text = nodes.map((node) => DomUtils.textContent(node)).join("");
  if (normalize(text) === normalize(title)) return true;
  function withoutNoteMarkers(node: (typeof nodes)[number]): string {
    if (node.type === "text") return node.data;
    if (!("children" in node)) return "";
    if ("name" in node) {
      const attributes = node.attribs;
      const internalLink = node.name === "a" && (attributes.href?.startsWith("#")
        || attributes["data-target-id"] || attributes["data-anchor-id"]);
      const noteText = normalize(DomUtils.textContent(node));
      const bracketedMarker = /^(?:\[\d+\]|〔\d+〕|【\d+】|\(\d+\)|[①-⑳*]+)$/.test(noteText);
      const linkedSuperscript = internalLink && /^\d+$/.test(noteText)
        && DomUtils.findOne((element) => element.name === "sup", node.children);
      if ((internalLink || attributes["data-annotation-id"] || attributes.role === "doc-noteref")
        && (bracketedMarker || linkedSuperscript)) return "";
    }
    return node.children.map(withoutNoteMarkers).join("");
  }
  // Compare without note labels, but preserve the source heading and its links.
  return normalize(nodes.map(withoutNoteMarkers).join("")) === normalize(title);
}

function annotationDisplayLabel(label: string | undefined): string {
  if (!label) return "注";
  return /^\*+$/.test(label) ? label : `[${label}]`;
}

const CHINESE_DIGITS: Record<string, number> = {
  "〇": 0, "零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
  "五": 5, "六": 6, "七": 7, "八": 8, "九": 9,
};

function chineseNumber(value: string): number | undefined {
  if (/^\d+$/.test(value)) return Number(value);
  if (value === "十") return 10;
  if (value.includes("十")) {
    const [tens, units] = value.split("十", 2);
    const high = tens ? CHINESE_DIGITS[tens] : 1;
    const low = units ? CHINESE_DIGITS[units] : 0;
    return high === undefined || low === undefined ? undefined : high * 10 + low;
  }
  if ([...value].every((character) => character in CHINESE_DIGITS)) {
    return Number([...value].map((character) => CHINESE_DIGITS[character]).join(""));
  }
  return undefined;
}

function annotationReference(value: string): { volumeNumber: number; chapterTitle: string; annotationLabel: string } | undefined {
  const match = value.match(/(?:见|参见)本书第([〇零一二两三四五六七八九十\d]+)卷《([^》]+)》注[〔\[]\s*(\d+)\s*[〕\]]/);
  if (!match) return undefined;
  const volumeNumber = chineseNumber(match[1]!);
  if (!volumeNumber) return undefined;
  return { volumeNumber, chapterTitle: match[2]!.trim(), annotationLabel: match[3]! };
}

function enhanceAnnotationMarkers(fragment: JojoFragment, html: string): string {
  const annotations = new Map(fragment.annotations.map((annotation) => [annotation.id, annotation]));
  return html.replace(
    /<sup\b[^>]*\bdata-annotation-id\s*=\s*(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/sup\s*>/gi,
    (source, _quote: string, annotationId: string, trailingHtml: string) => {
      const annotation = annotations.get(annotationId);
      if (!annotation) return source;
      const safeId = escapeHtml(annotation.id);
      const label = escapeHtml(annotationDisplayLabel(annotation.label));
      return `<sup id="annotation-ref-${safeId}" data-annotation-id="${safeId}"><a href="#${safeId}" aria-label="查看注释 ${label}">${label}</a></sup>${trailingHtml}`;
    },
  );
}

/** Stable DOM id for an anchor, including when multiple chapters share one document. */
export function bookChapterAnchorId(chapterId: string, anchorId: string): string {
  return `reader-chapter:${encodeURIComponent(chapterId)}:${encodeURIComponent(anchorId)}`;
}

function scopeChapterAnchors(html: string, chapterId: string): string {
  const document = parseDocument(html);
  for (const element of DomUtils.findAll(() => true, document.children)) {
    const attributes = element.attribs;
    if (attributes.id) {
      attributes["data-reader-anchor-id"] = attributes.id;
      attributes.id = bookChapterAnchorId(chapterId, attributes.id);
    }
    if (attributes.href?.startsWith("#") && attributes.href.length > 1) {
      let anchorId = attributes.href.slice(1);
      try {
        anchorId = decodeURIComponent(anchorId);
      } catch {
        // Preserve literal percent characters in legacy book anchors.
      }
      attributes["data-reader-href-anchor-id"] = anchorId;
      const targetChapter = attributes["data-target-id"] || chapterId;
      // href fragments are URL encoded; one decode returns the exact DOM id.
      attributes.href = `#${encodeURIComponent(bookChapterAnchorId(targetChapter, anchorId))}`;
    }
  }
  return DomUtils.getOuterHTML(document, { encodeEntities: "utf8" });
}

export function createBookChapterMarkup(fragment: JojoFragment, assetUrls: Record<string, string>): string {
  const sourceBody = insertAssets(safeBody(fragment), assetUrls);
  const bodyHasTitle = hasDuplicateLeadingTitle(sourceBody, fragment.title);
  const body = enhanceAnnotationMarkers(
    fragment,
    sourceBody,
  );
  const showTitle = fragment.title !== "封面" && fragment.title !== "插图" && !bodyHasTitle;
  const annotations = fragment.annotations.length
    ? `<section class="notes"><h2>本章注释</h2>${fragment.annotations.map((note) => {
      const reference = annotationReference(note.body.value);
      const referenceLink = reference
        ? ` <a href="#" data-reference-volume="${reference.volumeNumber}" data-reference-chapter="${escapeHtml(reference.chapterTitle)}" data-reference-label="${escapeHtml(reference.annotationLabel)}">跳转到原注</a>`
        : "";
      return `<p id="${escapeHtml(note.id)}" data-footnote-note="${escapeHtml(note.id)}"><strong>${escapeHtml(annotationDisplayLabel(note.label))}</strong>${escapeHtml(note.body.value)}${referenceLink} <a href="#annotation-ref-${escapeHtml(note.id)}" aria-label="返回正文">↩</a></p>`;
    }).join("")}</section>`
    : "";
  const content = `${showTitle ? `<h1>${escapeHtml(fragment.title)}</h1>` : ""}<div data-book-content data-target-id="${escapeHtml(fragment.fragmentId)}">${body}</div>${annotations}`;
  return `<article data-reader-chapter-id="${escapeHtml(fragment.fragmentId)}">${scopeChapterAnchors(content, fragment.fragmentId)}</article>`;
}

export function createBookDocument({ fragment, assetUrls, textScale, lineHeight, firstLineIndent, eInk, readingMode, paperColor }: BookDocumentOptions): string {
  const chapterMarkup = createBookChapterMarkup(fragment, assetUrls);
  const effectivePaperColor = eInk ? "white" : paperColor;
  const paper = effectivePaperColor === "ivory" ? "#fbfaf6" : effectivePaperColor === "dark" ? "#202321" : "#ffffff";
  const ink = effectivePaperColor === "dark" ? "#deded8" : "#202020";
  const muted = effectivePaperColor === "dark" ? "#a8aaa6" : "#68645f";
  const accent = eInk ? "#000000" : effectivePaperColor === "dark" ? "#d46666" : "#8b1a1a";
  const highlight = eInk ? "transparent" : effectivePaperColor === "dark" ? "rgba(212, 102, 102, .28)" : "rgba(139, 26, 26, .16)";
  const gutter = eInk ? "#8a8a8a" : "rgba(139, 26, 26, .22)";
  const readingLayout = readingMode === "paged" ? `
  html, body { width: 100%; height: 100%; overflow: hidden; overscroll-behavior: none; }
  body { touch-action: pan-y pinch-zoom; }
  article {
    width: 100vw;
    height: 100vh;
    max-width: none;
    margin: 0;
    padding: 5rem 2rem;
    column-count: 1;
    column-fill: auto;
    column-gap: 4rem;
    overflow: visible;
    transform: translate3d(0, 0, 0);
    transform-origin: left top;
  }
  #jojo-page-footer {
    position: fixed;
    z-index: 2;
    left: 0;
    right: 0;
    bottom: .75rem;
    display: grid;
    color: ${muted};
    font-family: sans-serif;
    font-size: .72rem;
    line-height: 1;
    text-align: center;
    pointer-events: none;
  }
  @media (orientation: landscape) and (min-width: 900px) {
    article {
      padding: 5rem 4rem;
      column-count: 2;
      column-gap: 8rem;
      column-rule: 1px solid ${gutter};
    }
  }
  ` : `
  html { overflow-x: hidden; }
  html, body, article { overflow-anchor: none; }
  article { width: 100%; max-width: 52rem; margin: 0 auto; padding: 5rem 1.35rem; }
  [data-reader-chapter-slot] article { padding-top: 2rem; padding-bottom: 2rem; }
  [data-reader-chapter-slot]:first-of-type article { padding-top: 5rem; }
  [data-reader-chapter-slot]:last-of-type article { padding-bottom: 5rem; }
  `;

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=3,user-scalable=yes">
<style>
  * { box-sizing: border-box; }
  html { background: ${paper}; color: ${ink}; font-size: ${16 * textScale}px; }
  body { margin: 0; background: ${paper}; color: ${ink}; font-family: "Noto Serif SC", "Source Han Serif SC", serif; }
  article { font-size: 1rem; line-height: ${lineHeight}; -webkit-user-select: text; user-select: text; }
  h1, h2, h3, h4 { color: ${accent}; line-height: 1.45; text-align: left; }
  h1 { margin: 0 0 2.2rem; font-size: 1.75rem; font-weight: 700; }
  h2 { margin: 2.2rem 0 1rem; font-size: 1.35rem; }
  p { margin: 1.05em 0; text-align: justify; text-indent: ${firstLineIndent ? "2em" : "0"}; overflow-wrap: anywhere; }
  blockquote { margin: 1.4rem 0; padding-left: 1rem; border-left: 2px solid ${accent}; }
  figure { margin: 2rem auto; text-align: center; }
  figure img, article > img { display: block; max-width: 100%; height: auto; margin: 0 auto; ${eInk ? "filter: grayscale(1) contrast(1.15);" : ""} }
  span[data-asset-id] img { display: inline-block; max-width: 100%; height: auto; vertical-align: middle; }
  figcaption { margin-top: .65rem; color: ${muted}; font-family: sans-serif; font-size: .75rem; text-align: center; }
  a[href], a[data-target-id], a[data-anchor-id] { color: ${accent}; }
  hr { margin: 2rem 0; border: 0; border-top: 1px solid #aaa; }
  .notes { margin-top: 4rem; padding-top: 1.5rem; border-top: 1px solid #aaa; font-size: .84rem; }
  .notes h2 { margin-top: 0; color: ${ink}; font-family: sans-serif; font-size: .9rem; letter-spacing: .12em; }
  .notes p { text-indent: 0; }
  .notes strong { margin-right: .5em; color: ${accent}; }
  sup[data-annotation-id] { margin: 0 .08em; font-family: sans-serif; font-size: .72em; line-height: 1; }
  [data-footnote-note] { border-left: 1px solid ${gutter}; padding-left: .75rem; }
  [data-book-jump-target] { outline: 2px solid ${accent}; outline-offset: 3px; background: ${highlight}; }
  ::selection { background: ${eInk ? "#b8b8b8" : effectivePaperColor === "dark" ? "#765252" : "#e6c5c5"}; color: ${ink}; }
  mark[data-annotation-id] { border-bottom: 2px solid ${accent}; background: ${highlight}; color: inherit; }
  mark[data-search-target] { background: ${eInk ? "transparent" : "rgba(224, 174, 61, .28)"}; color: inherit; outline: 1px solid ${accent}; }
  h1, h2, h3, h4 { break-after: avoid-column; }
  figure, blockquote, .notes { break-inside: avoid-column; }
  ${readingLayout}
</style></head><body data-reading-mode="${readingMode}">${chapterMarkup}</body></html>`;
}
