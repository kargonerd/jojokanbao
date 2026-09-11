import { afterEach, describe, expect, it, vi } from "vitest";
import { findPdfSearchRanges, paintPdfSearchRanges } from "../../packages/pdf-viewer/src/searchText";

function layer(...parts: string[]): HTMLElement {
  const root = document.createElement("div");
  parts.forEach((part) => {
    const span = document.createElement("span");
    span.textContent = part;
    root.append(span);
  });
  return root;
}

afterEach(() => vi.restoreAllMocks());

describe("PDF text location", () => {
  it("matches Chinese phrases across spans and whitespace with original offsets", () => {
    const root = layer("修建铁", "\n路通", "车。铁路运输。");
    const found = findPdfSearchRanges(root, "铁路");
    expect(found.result).toEqual({ status: "found", matches: 2 });
    expect(found.ranges.map((range) => range.toString())).toEqual(["铁\n路", "铁路"]);
    expect(found.ranges[0]!.startOffset).toBe(2);
    expect(found.ranges[0]!.endOffset).toBe(2);
  });
  it("prefers an article excerpt and falls back to query if OCR differs", () => {
    const root = layer("铁路通车。铁路运输。");
    expect(findPdfSearchRanges(root, "铁路", "铁路运输").ranges[0]!.toString()).toBe("铁路运输");
    expect(findPdfSearchRanges(root, "铁路", "旧版标题").result.matches).toBe(2);
  });
  it("normalizes full width text and ligatures without corrupting ranges", () => {
    const root = layer("ＡＢＣ ﬃ");
    expect(findPdfSearchRanges(root, "abc").ranges[0]!.toString()).toBe("ＡＢＣ");
    expect(findPdfSearchRanges(root, "ffi").ranges[0]!.toString()).toBe("ﬃ");
  });
  it("distinguishes scan-only pages from text without the requested phrase", () => {
    expect(findPdfSearchRanges(layer(" "), "铁路").result.status).toBe("no-text");
    expect(findPdfSearchRanges(layer("公路"), "铁路").result.status).toBe("not-found");
    expect(findPdfSearchRanges(layer("公路"), "").ranges).toEqual([]);
  });
  it("uses only measured text rectangles and removes highlights without changing selectable text", () => {
    const root = layer("铁路");
    const { ranges } = findPdfSearchRanges(root, "铁路");
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue({ left: 100, top: 200, width: 400, height: 600 } as DOMRect);
    Object.defineProperty(ranges[0], "getClientRects", { value: () => [{ left: 140, top: 320, width: 80, height: 30 }] });
    const highlight = paintPdfSearchRanges(root, ranges, 0);
    expect(highlight.active?.style.left).toBe("10%");
    expect(highlight.active?.style.top).toBe("20%");
    expect(highlight.active?.style.width).toBe("20%");
    expect(highlight.active?.style.height).toBe("5%");
    expect(root.textContent).toBe("铁路");
    highlight.cleanup();
    expect(root.querySelector(".pdf-search-highlight")).toBeNull();
  });
  it("never fabricates a highlight for scan-only pages", () => {
    const root = layer();
    const highlight = paintPdfSearchRanges(root, findPdfSearchRanges(root, "铁路").ranges, 0);
    expect(highlight.active).toBeNull();
    expect(root.childElementCount).toBe(0);
  });
});
