import { afterEach, describe, expect, it, vi } from "vitest";
import { findPdfSearchRanges, paintPdfSearchRanges, selectPdfOutlineTitleRanges } from "../../packages/pdf-viewer/src/searchText";

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
  it("matches the complete title and never falls back to words in other articles", () => {
    const root = layer("铁路通车。铁路运输。");
    expect(findPdfSearchRanges(root, "铁路", "铁路运输").ranges[0]!.toString()).toBe("铁路运输");
    const missing = findPdfSearchRanges(root, "铁路", "铁路运输改革");
    expect(missing.result).toEqual({ status: "not-found", matches: 0 });
    expect(missing.ranges).toEqual([]);
    expect(findPdfSearchRanges(root, "铁路", "").ranges).toEqual([]);
  });
  it("matches the full title across PDF spans without accepting missing characters", () => {
    const root = layer("教育事业。教\n育者", "要先受", "教育。教育改革。");
    expect(findPdfSearchRanges(root, "教育", "教育者要先受教育").ranges.map((range) => range.toString()))
      .toEqual(["教\n育者要先受教育"]);
    expect(findPdfSearchRanges(layer("教育者先受教育。教育。"), "教育", "教育者要先受教育").ranges).toEqual([]);
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

describe("bookmark title highlights", () => {
  function matches(rectangles: number[][][], scale = 1) {
    const root = layer(...rectangles.map(() => "教育者要先受教育。"), "正文内容");
    const { ranges } = findPdfSearchRanges(root, "教育", "教育者要先受教育");
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue({ left: 100, top: 200, width: 1000 * scale, height: 1400 * scale } as DOMRect);
    ranges.forEach((range, index) => {
      Object.defineProperty(range, "getClientRects", { value: () => rectangles[index]!.map(([x, y, w, h]) => ({
        left: 100 + x! * scale, top: 200 + y! * scale,
        right: 100 + (x! + w!) * scale, bottom: 200 + (y! + h!) * scale,
        width: w! * scale, height: h! * scale,
      })) });
      vi.spyOn(root.children[index]!, "getBoundingClientRect").mockImplementation(() => range.getClientRects()[0] as DOMRect);
    });
    vi.spyOn(root.lastElementChild!, "getBoundingClientRect").mockReturnValue({ left: 100 + 600 * scale, top: 200 + 650 * scale,
      right: 100 + 608 * scale, bottom: 200 + 690 * scale, width: 8 * scale, height: 40 * scale } as DOMRect);
    return { root, ranges };
  }

  it.each([1, 2.5])("marks only the title beside the bookmark, independent of OCR order and zoom (%s)", (scale) => {
    const { root, ranges } = matches([[[570, 580, 8, 8]], [[910, 590, 18, 18]]], scale);
    const selected = selectPdfOutlineTitleRanges(root, ranges, { left: .91, top: 580 / 1400 });
    expect(selected).toEqual([ranges[1]]);
    const highlight = paintPdfSearchRanges(root, selected, 0);
    expect(root.querySelectorAll(".pdf-search-highlight")).toHaveLength(1);
    expect(highlight.active?.style.left).toBe("91%");
    highlight.cleanup();
  });

  it("compares the first character instead of a box spanning wrapped body columns", () => {
    const { root, ranges } = matches([
      [[580, 705, 8, 8], [570, 579, 8, 65]],
      [[910, 590, 18, 18], [910, 608, 18, 125]],
    ]);
    expect(selectPdfOutlineTitleRanges(root, ranges, { top: 580 / 1400 })).toEqual([ranges[1]]);
  });

  it("keeps all measured characters of one wrapped title", () => {
    const { root, ranges } = matches([[[910, 590, 18, 72], [890, 590, 18, 72]], [[570, 590, 8, 65]]]);
    const selected = selectPdfOutlineTitleRanges(root, ranges, { left: .91, top: 580 / 1400 });
    expect(selected).toEqual([ranges[0]]);
    const highlight = paintPdfSearchRanges(root, selected, 0);
    expect(root.querySelectorAll(".pdf-search-highlight")).toHaveLength(2);
    highlight.cleanup();
  });

  it("does not mark a distant body occurrence when OCR omitted the title", () => {
    const { root, ranges } = matches([[[570, 590, 8, 65]]]);
    expect(selectPdfOutlineTitleRanges(root, ranges, { left: .91, top: 580 / 1400 })).toEqual([]);
    expect(selectPdfOutlineTitleRanges(root, [], { left: .91, top: 580 / 1400 })).toEqual([]);
  });

  it("does not guess between equally close text for a bookmark without a horizontal position", () => {
    const { root, ranges } = matches([[[570, 590, 8, 65]], [[910, 590, 18, 144]]]);
    expect(selectPdfOutlineTitleRanges(root, ranges, { top: 580 / 1400 })).toEqual([]);
  });

  it("ignores invisible text and unmeasured pages", () => {
    const { root, ranges } = matches([[[910, 590, 0, 0]]]);
    expect(selectPdfOutlineTitleRanges(root, ranges, { left: .91, top: 580 / 1400 })).toEqual([]);
    vi.mocked(root.getBoundingClientRect).mockReturnValue({ width: 0, height: 0 } as DOMRect);
    expect(selectPdfOutlineTitleRanges(root, ranges, { left: .91, top: 580 / 1400 })).toEqual([]);
  });

  it.each([1, 2.5])("uses a FitR article box and headline type size for the actual vertical layout (%s)", (scale) => {
    const { root, ranges } = matches([[[584, 706, 7.4, 7.4], [574, 579, 7.4, 56]], [[911, 592, 17.8, 17.8], [911, 610, 17.8, 125]]], scale);
    const selected = selectPdfOutlineTitleRanges(root, ranges, { top: .393, left: .5015, right: .93, bottom: .674 });
    expect(selected).toEqual([ranges[1]]);
    const highlight = paintPdfSearchRanges(root, selected, 0);
    expect(root.querySelectorAll(".pdf-search-highlight")).toHaveLength(2);
    expect(highlight.active?.style.left).toBe("91.1%");
    highlight.cleanup();
  });

  it("does not substitute body text when the FitR headline is missing", () => {
    const { root, ranges } = matches([[[574, 579, 7.4, 56]]]);
    expect(selectPdfOutlineTitleRanges(root, ranges, { top: .393, left: .5015, right: .93, bottom: .674 })).toEqual([]);
  });

  it("excludes headings outside the article and rejects ambiguous headings inside it", () => {
    const { root, ranges } = matches([[[400, 592, 18, 144]], [[911, 592, 18, 144]], [[870, 592, 18, 144]]]);
    expect(selectPdfOutlineTitleRanges(root, ranges.slice(0, 1), { top: .393, left: .5015, right: .93, bottom: .674 })).toEqual([]);
    expect(selectPdfOutlineTitleRanges(root, ranges, { top: .393, left: .5015, right: .93, bottom: .674 })).toEqual([]);
  });
});
