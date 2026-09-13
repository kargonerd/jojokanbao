import DOMPurify from "dompurify";
import { JOJO_BOOK_SEARCH_BLOCK_SELECTOR, bookSearchBlockAnchorId } from "./book-search";
import type { JojoFragment } from "./types";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function annotationMarkerId(annotationId: string): string {
  return `annotation-ref-${annotationId}`;
}

function annotationDisplayLabel(label: string | undefined): string {
  if (!label) return "注";
  return /^\*+$/.test(label) ? label : `[${label}]`;
}

function matchesChapterTitle(heading: Element | undefined, title: string): boolean {
  if (!heading || !/^H[1-6]$/.test(heading.tagName)) return false;
  const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/g, "");
  if (normalize(heading.textContent || "") === normalize(title)) return true;
  // Work on a detached copy: the displayed title keeps every note and anchor.
  const comparison = heading.cloneNode(true) as Element;
  for (const marker of comparison.querySelectorAll('a[href^="#"],a[data-target-id],a[data-anchor-id],[data-annotation-id],[role="doc-noteref"]')) {
    const text = normalize(marker.textContent || "");
    if (/^(?:\[\d+\]|〔\d+〕|【\d+】|\(\d+\)|[①-⑳*]+)$/.test(text)
      || (marker.tagName === "A" && /^\d+$/.test(text) && marker.querySelector("sup"))) marker.remove();
  }
  return normalize(comparison.textContent || "") === normalize(title);
}

export function renderedChapter(fragment: JojoFragment, assetUrls: Record<string, string>): { titleHtml: string; bodyHtml: string } {
  const source = fragment.body.format === "html"
    ? fragment.body.value
    : fragment.body.value.split(/\n{2,}/).map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br>")}</p>`).join("");
  const clean = DOMPurify.sanitize(source);
  const document = new DOMParser().parseFromString(`<main>${clean}</main>`, "text/html");
  const main = document.querySelector("main");
  let titleHeading: Element | undefined;
  let searchBlockNumber = 0;
  for (const element of document.querySelectorAll<HTMLElement>(JOJO_BOOK_SEARCH_BLOCK_SELECTOR)) {
    if (element.parentElement?.closest(JOJO_BOOK_SEARCH_BLOCK_SELECTOR)) continue;
    if (!element.textContent?.normalize("NFKC").replace(/\s+/g, " ").trim()) continue;
    searchBlockNumber += 1;
    if (!element.id) element.id = bookSearchBlockAnchorId(fragment.fragmentId, searchBlockNumber);
  }
  const firstContentElement = [...(main?.children ?? [])].find((element) => (
    element.tagName !== "HR"
    && (element.textContent?.replace(/\s+/g, "").length || element.querySelector("img,figure,svg"))
  ));
  if (/^H[1-6]$/.test(firstContentElement?.tagName ?? "")
    && firstContentElement?.textContent?.normalize("NFKC").replace(/\s+/g, " ").trim()
      === fragment.title.normalize("NFKC").replace(/\s+/g, " ").trim()) {
    const headingId = firstContentElement.id;
    if (headingId) {
      const anchor = document.createElement("span");
      anchor.id = headingId;
      firstContentElement.before(anchor);
    }
    // Render the source title's inline content inside the page's heading.
    // Keep it in the document until asset and annotation markers are resolved.
    titleHeading = firstContentElement;
  }
  if (fragment.title.normalize("NFKC").trim() === "目录") {
    const selfEntry = [...(main?.children ?? [])].find((element) => (
      element !== titleHeading && element.textContent?.normalize("NFKC").replace(/\s+/g, "").trim() === "目录"
    ));
    selfEntry?.remove();
  }
  for (const placeholder of document.querySelectorAll("figure[data-asset-id], span[data-asset-id]")) {
    const assetId = placeholder.getAttribute("data-asset-id") || "";
    const url = assetUrls[assetId];
    if (!url) continue;
    const image = document.createElement("img");
    image.src = url;
    if (placeholder.tagName === "SPAN") {
      image.alt = "行内图片";
      image.setAttribute("data-book-inline-asset", "true");
      placeholder.append(image);
      continue;
    }
    const role = placeholder.getAttribute("data-role");
    image.alt = placeholder.querySelector("figcaption")?.textContent
      || (role === "cover" ? "封面" : role === "table-image" ? "表格" : "正文图片");
    const width = Number(placeholder.getAttribute("data-width"));
    if (Number.isInteger(width) && width >= 10 && width <= 100) {
      (placeholder as HTMLElement).style.maxWidth = `${width}%`;
    }
    placeholder.prepend(image);
  }
  const annotations = new Map(fragment.annotations.map((annotation) => [annotation.id, annotation]));
  for (const marker of document.querySelectorAll("sup[data-annotation-id]")) {
    const annotationId = marker.getAttribute("data-annotation-id") || "";
    const annotation = annotations.get(annotationId);
    if (!annotation) continue;
    const trailingText = marker.textContent || "";
    marker.id = annotationMarkerId(annotationId);
    marker.textContent = "";
    const link = document.createElement("a");
    link.href = `#${annotationId}`;
    link.textContent = annotationDisplayLabel(annotation.label);
    link.title = annotation.body.value;
    link.setAttribute("aria-label", `查看注释 ${annotation.label || "注"}`);
    link.className = "book-footnote-link text-red no-underline font-bold";
    marker.append(link);
    if (trailingText) marker.after(document.createTextNode(trailingText));
  }
  if (firstContentElement && firstContentElement !== titleHeading && matchesChapterTitle(firstContentElement, fragment.title)) {
    firstContentElement.classList.add("book-chapter-title");
  }
  const titleHtml = titleHeading?.innerHTML ?? escapeHtml(fragment.title);
  titleHeading?.remove();
  // Only internally generated Blob URLs are inserted after sanitization.
  return { titleHtml, bodyHtml: main?.innerHTML || "" };
}

export function renderedBody(fragment: JojoFragment, assetUrls: Record<string, string>): string {
  return renderedChapter(fragment, assetUrls).bodyHtml;
}

export function shouldRenderChapterTitle(fragment: JojoFragment, html: string): boolean {
  const document = new DOMParser().parseFromString(`<main>${html}</main>`, "text/html");
  const main = document.querySelector("main");
  if (fragment.title !== "封面" && fragment.title !== "插图") {
    const heading = [...(main?.children ?? [])].find((element) => element.tagName !== "HR"
      && (element.textContent?.replace(/\s+/g, "") || element.querySelector("img,figure,svg")));
    return !matchesChapterTitle(heading, fragment.title);
  }
  return Boolean(main?.textContent?.replace(/\s+/g, "").length) || !main?.querySelector("img,figure,svg");
}
