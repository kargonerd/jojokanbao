export interface PdfOutlinePosition {
  top: number;
  left?: number;
  right?: number;
  bottom?: number;
}

export interface PdfSearchTarget {
  page: number;
  query: string;
  quote?: string;
  activeIndex?: number;
  focusToken?: number;
  outline?: PdfOutlinePosition;
}

export interface PdfSearchResult {
  status: "outline" | "found" | "no-text" | "not-found" | "unavailable";
  matches: number;
}

interface TextPosition { node: Text; start: number; end: number }

export function normalizePdfSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\u00ad\u200b]/gu, "");
}

/** Match across PDF.js spans while retaining the original DOM offsets. */
export function findPdfSearchRanges(layer: HTMLElement, query: string, quote?: string): {
  result: PdfSearchResult;
  ranges: Range[];
} {
  const positions: TextPosition[] = [];
  let text = "";
  const walker = layer.ownerDocument.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    const node = current as Text;
    let offset = 0;
    for (const character of node.data) {
      const normalized = normalizePdfSearchText(character);
      for (let index = 0; index < normalized.length; index += 1) {
        positions.push({ node, start: offset, end: offset + character.length });
      }
      text += normalized;
      offset += character.length;
    }
    current = walker.nextNode();
  }
  if (!text) return { result: { status: "no-text", matches: 0 }, ranges: [] };
  // A supplied title/excerpt is authoritative; a broader query could match
  // an unrelated article on the same page. Empty targets also fail closed.
  const needle = normalizePdfSearchText(quote ?? query);
  if (!needle || !text.includes(needle)) return { result: { status: "not-found", matches: 0 }, ranges: [] };

  const ranges: Range[] = [];
  let start = text.indexOf(needle);
  while (start !== -1 && ranges.length < 200) {
    const first = positions[start];
    const last = positions[start + needle.length - 1];
    if (first && last) {
      const range = layer.ownerDocument.createRange();
      range.setStart(first.node, first.start);
      range.setEnd(last.node, last.end);
      ranges.push(range);
    }
    start = text.indexOf(needle, start + needle.length);
  }
  return { result: { status: "found", matches: ranges.length }, ranges };
}

/** A bookmark identifies one title, even when its words also appear in the body. */
export function selectPdfOutlineTitleRanges(
  container: HTMLElement,
  ranges: Range[],
  position: PdfOutlinePosition,
  layer: HTMLElement = container,
): Range[] {
  const bounds = container.getBoundingClientRect();
  if (!(bounds.width > 0 && bounds.height > 0)) return [];
  if (position.left !== undefined && position.right !== undefined && position.bottom !== undefined) {
    // FitR bookmarks frame the article, not necessarily the title's start.
    // In vertical newspapers its headline may be on the far right of the box.
    const inside = (rect: DOMRect) => (rect.left - bounds.left) / bounds.width >= position.left! - .005
      && (rect.right - bounds.left) / bounds.width <= position.right! + .005
      && (rect.top - bounds.top) / bounds.height >= position.top - .005
      && (rect.bottom - bounds.top) / bounds.height <= position.bottom! + .005;
    const bodySizes = Array.from(layer.querySelectorAll("span"))
      .filter((span) => span.textContent?.trim() && !span.querySelector("span"))
      .map((span) => span.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0 && inside(rect))
      .map((rect) => Math.min(rect.width, rect.height)).sort((a, b) => a - b);
    const bodySize = bodySizes[Math.floor(bodySizes.length / 2)];
    if (!bodySize) return [];
    const titles = ranges.flatMap((range) => {
      const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
      if (!rects.length || !rects.every(inside)) return [];
      const size = Math.min(rects[0]!.width, rects[0]!.height);
      return size >= bodySize * 1.2 ? [{ range, size }] : [];
    }).sort((a, b) => b.size - a.size);
    // A body occurrence alone must not stand in for an OCR-missing headline.
    if (!titles[0] || (titles[1] && titles[0].size < titles[1].size * 1.2)) return [];
    return [titles[0].range];
  }
  const x = position.left === undefined ? undefined : bounds.left + position.left * bounds.width;
  const y = bounds.top + position.top * bounds.height;
  const candidates = ranges.flatMap((range) => {
    // Use the start of the title, not a union box spanning wrapped lines or
    // vertical columns. Body text can wrap back above its first character.
    const first = Array.from(range.getClientRects()).find((rect) => rect.width > 0 && rect.height > 0);
    if (!first) return [];
    const dy = Math.max(first.top - y, y - first.bottom, 0) / bounds.height;
    const dx = x === undefined ? 0 : Math.max(first.left - x, x - first.right, 0) / bounds.width;
    // Allow small bookmark/OCR padding, but never search elsewhere on the page
    // for a substitute when the actual title is missing from the text layer.
    if (dx > .03 || dy > .03) return [];
    return [{ range, distance: Math.hypot(dx, dy) }];
  }).sort((a, b) => a.distance - b.distance);
  const closest = candidates[0];
  if (!closest) return [];
  // FitH bookmarks have no horizontal coordinate. If two candidates are
  // equally close, retain the location without guessing which one to mark.
  if (candidates[1] && candidates[1].distance - closest.distance < .002) return [];
  return [closest.range];
}

/** Rectangles come from rendered PDF text only; scan images have no fallback boxes. */
export function paintPdfSearchRanges(container: HTMLElement, ranges: Range[], activeIndex: number): {
  active: HTMLElement | null;
  cleanup: () => void;
} {
  const bounds = container.getBoundingClientRect();
  const markers: HTMLElement[] = [];
  const highlightLayer = container.ownerDocument.createElement("div");
  highlightLayer.className = "pdf-search-highlights";
  highlightLayer.setAttribute("aria-hidden", "true");
  let active: HTMLElement | null = null;
  if (bounds.width > 0 && bounds.height > 0) {
    ranges.forEach((range, index) => {
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width <= 0 || rect.height <= 0) continue;
        const marker = container.ownerDocument.createElement("div");
        marker.className = `pdf-search-highlight${index === activeIndex ? " pdf-search-highlight-active" : ""}`;
        marker.setAttribute("aria-hidden", "true");
        Object.assign(marker.style, {
          left: `${100 * (rect.left - bounds.left) / bounds.width}%`,
          top: `${100 * (rect.top - bounds.top) / bounds.height}%`,
          width: `${100 * rect.width / bounds.width}%`,
          height: `${100 * rect.height / bounds.height}%`,
        });
        highlightLayer.append(marker);
        markers.push(marker);
        if (index === activeIndex && !active) active = marker;
      }
    });
  }
  if (markers.length) container.append(highlightLayer);
  return { active, cleanup: () => highlightLayer.remove() };
}
