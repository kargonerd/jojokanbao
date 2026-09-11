import type { PDFDocumentProxy } from "pdfjs-dist";
import { describe, expect, it, vi } from "vitest";
import { findPdfOutlineLocation, resolvePdfOutlineDestination, type PdfOutlineItem } from "../../packages/pdf-viewer/src/outline";

function pdf() {
  return {
    numPages: 6,
    getDestination: vi.fn().mockResolvedValue([1, { name: "XYZ" }, 100, 700, null]),
    getPageIndex: vi.fn().mockResolvedValue(1),
    getPage: vi.fn().mockResolvedValue({ view: [0, 0, 1000, 1000], getViewport: () => ({
      width: 1000, height: 1000, rotation: 0, convertToViewportPoint: (x: number, y: number) => [x, 1000 - y],
    }) }),
  };
}
function item(title: string, dest: PdfOutlineItem["dest"], items: PdfOutlineItem[] = []): PdfOutlineItem {
  return { title, dest, items };
}

describe("PDF outline locations", () => {
  it.each([
    [[1, { name: "XYZ" }, 100, 700, null], { top: .3, left: .1 }],
    [[1, { name: "FitH" }, 700], { top: .3 }],
    [[1, { name: "FitBH" }, 700], { top: .3 }],
    [[1, { name: "FitR" }, 100, 200, 400, 700], { top: .3, left: .1 }],
  ])("resolves explicit PDF coordinates %j", async (dest, position) => {
    expect(await resolvePdfOutlineDestination(pdf() as unknown as PDFDocumentProxy, dest as unknown[])).toEqual({ page: 2, position });
  });
  it("resolves named destinations and reference objects through the same path", async () => {
    const document = pdf();
    document.getDestination.mockResolvedValue([{ num: 10, gen: 0 }, { name: "FitH" }, 800]);
    expect(await resolvePdfOutlineDestination(document as unknown as PDFDocumentProxy, "article"))
      .toEqual({ page: 2, position: { top: .2 } });
    expect(document.getPageIndex).toHaveBeenCalledWith({ num: 10, gen: 0 });
  });
  it("matches complete titles across whitespace only on the requested edition", async () => {
    const document = pdf();
    const outline = [item("第二版", null, [
      item("教育者要先受教育", [0, { name: "FitH" }, 200]),
      item("教 育者\n要先受教育", [1, { name: "FitH" }, 700]),
      item("教育", [1, { name: "FitH" }, 900]),
    ])];
    expect(await findPdfOutlineLocation(document as unknown as PDFDocumentProxy, outline, "教育者要先受教育", 2))
      .toEqual({ page: 2, position: { top: .3 } });
    expect(document.getPage).toHaveBeenCalledExactlyOnceWith(2);
    expect(await findPdfOutlineLocation(document as unknown as PDFDocumentProxy, outline, "教育者要先受教育改革", 2)).toBeNull();
  });
  it("rejects ambiguous locations while allowing duplicate bookmarks for the same position", async () => {
    const document = pdf() as unknown as PDFDocumentProxy;
    const first = item("完整标题", [1, { name: "FitH" }, 700]);
    expect(await findPdfOutlineLocation(document, [first, first], "完整标题", 2)).toEqual({ page: 2, position: { top: .3 } });
    expect(await findPdfOutlineLocation(document, [first, item("完整标题", [1, { name: "FitH" }, 200])], "完整标题", 2)).toBeNull();
  });
  it("retains page-only manual navigation but does not treat it as an article position", async () => {
    const document = pdf() as unknown as PDFDocumentProxy;
    expect(await resolvePdfOutlineDestination(document, [1, { name: "Fit" }])).toEqual({ page: 2 });
    expect(await findPdfOutlineLocation(document, [item("完整标题", [1, { name: "Fit" }])], "完整标题", 2)).toBeNull();
  });
  it("falls back on invalid, missing, or failed destinations", async () => {
    const document = pdf();
    for (const dest of [null, [], [-1, { name: "Fit" }], [20, { name: "Fit" }]]) {
      expect(await resolvePdfOutlineDestination(document as unknown as PDFDocumentProxy, dest)).toBeNull();
    }
    expect(await findPdfOutlineLocation(document as unknown as PDFDocumentProxy, [item("完整标题", [1, { name: "FitH" }, 2000])], "完整标题", 2)).toBeNull();
    document.getDestination.mockRejectedValue(new Error("invalid bookmark"));
    expect(await findPdfOutlineLocation(document as unknown as PDFDocumentProxy, [item("完整标题", "broken")], "完整标题", 2)).toBeNull();
  });
});
