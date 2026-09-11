export interface PdfSearchTarget {
  page: number;
  query: string;
  quote?: string;
  activeIndex?: number;
  focusToken?: number;
}

export interface PdfSearchResult {
  status: "found" | "no-text" | "not-found" | "unavailable";
  matches: number;
}

interface TextPosition { node: Text; start: number; end: number }

function normalize(value: string): string {
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
      const normalized = normalize(character);
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
  const needle = normalize(quote ?? query);
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
