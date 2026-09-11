import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PdfViewer } from "../../packages/pdf-viewer/src/PdfViewer";
import type { PdfSearchResult, PdfSearchTarget } from "../../packages/pdf-viewer/src/searchText";

interface PageProps {
  document: unknown;
  pageNumber: number;
  enableTextLayer?: boolean;
  searchTarget?: PdfSearchTarget;
  onPageMetrics?: (page: number, metrics: { width: number; height: number }) => void;
  onSearchResult?: (result: PdfSearchResult, active: HTMLElement | null) => void;
}
const mocks = vi.hoisted(() => ({ pages: new Map<number, PageProps>() }));
vi.mock("../../packages/pdf-viewer/src/PdfPage", async () => {
  const { useEffect } = await import("react");
  return { PdfPage: (props: PageProps) => {
    mocks.pages.set(props.pageNumber, props);
    useEffect(() => {
      let disposed = false;
      void Promise.resolve().then(() => { if (!disposed) props.onPageMetrics?.(props.pageNumber, { width: 600, height: 1000 }); });
      return () => { disposed = true; };
    }, [props.document, props.pageNumber]);
    return <span data-testid={`hit-${props.pageNumber}`}>完整标题</span>;
  } };
});

afterEach(() => { cleanup(); document.body.replaceChildren(); mocks.pages.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup() {
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const scroll = document.createElement("div");
  const controls = document.createElement("div");
  controls.setAttribute("data-reader-controls", "");
  const host = document.createElement("div");
  scroll.append(controls, host);
  document.body.append(scroll);
  scroll.scrollTop = 50;
  scroll.scrollTo = vi.fn();
  Object.defineProperties(scroll, { clientWidth: { value: 600 }, clientHeight: { value: 800 } });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const top = this === scroll ? 100 : this.id === "page-2" ? 1500 : 5000;
    return { top, left: 0, width: 600, height: this === controls ? 60 : 1000 } as DOMRect;
  });
  const pdf = { numPages: 2 } as PDFDocumentProxy;
  return { scroll, host, pdf };
}

describe("outline-first PDF positioning", () => {
  it.each([true, false])("positions at the bookmark and limits later highlighting to its title (text enabled: %s)", async (enableTextLayer) => {
    const { scroll, host, pdf } = setup();
    const onSearchResult = vi.fn();
    const view = render(<PdfViewer document={pdf} initialPage={2} enableTextLayer={enableTextLayer} scrollContainerRef={{ current: scroll }}
      searchTarget={{ page: 2, query: "", quote: "完整标题", outline: { top: .25 } }} onSearchResult={onSearchResult} />, { container: host });
    await waitFor(() => expect(onSearchResult).toHaveBeenCalledWith({ status: "outline", matches: 0 }));
    expect(scroll.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 1624 });
    expect(host.querySelector("[data-pdf-viewer]")?.getAttribute("data-search-location")).toBe("outline");
    expect(mocks.pages.get(2)!.searchTarget).toEqual({ page: 2, query: "", quote: "完整标题", outline: { top: .25 } });
    expect(mocks.pages.get(2)!.enableTextLayer).toBe(true);
    vi.mocked(scroll.scrollTo).mockClear();
    act(() => mocks.pages.get(2)!.onSearchResult?.({ status: "found", matches: 2 }, view.getByTestId("hit-2")));
    act(() => mocks.pages.get(2)!.onSearchResult?.({ status: "no-text", matches: 0 }, null));
    expect(scroll.scrollTo).not.toHaveBeenCalled();
    expect(onSearchResult).toHaveBeenCalledExactlyOnceWith({ status: "outline", matches: 0 });
  });

  it("uses measured text coordinates when no article bookmark exists", async () => {
    const { scroll, host, pdf } = setup();
    const view = render(<PdfViewer document={pdf} initialPage={2} scrollContainerRef={{ current: scroll }}
      searchTarget={{ page: 2, query: "", quote: "完整标题" }} />, { container: host });
    expect(mocks.pages.get(2)!.searchTarget).toEqual({ page: 2, query: "", quote: "完整标题" });
    expect(scroll.scrollTo).not.toHaveBeenCalled();
    act(() => mocks.pages.get(2)!.onSearchResult?.({ status: "found", matches: 1 }, view.getByTestId("hit-2")));
    expect(scroll.scrollTo).toHaveBeenCalledWith({ top: 4550, left: 0 });
    expect(host.querySelector("[data-pdf-viewer]")?.getAttribute("data-search-location")).toBe("text");
  });

  it("restricts an existing page text search to the bookmark when switching on the same page", async () => {
    const { scroll, host, pdf } = setup();
    const onSearchResult = vi.fn();
    const target = { page: 2, query: "", quote: "完整标题" };
    const view = render(<PdfViewer document={pdf} initialPage={2} scrollContainerRef={{ current: scroll }}
      searchTarget={target} onSearchResult={onSearchResult} />, { container: host });
    expect(mocks.pages.get(2)!.searchTarget).toEqual(target);
    view.rerender(<PdfViewer document={pdf} initialPage={2} scrollContainerRef={{ current: scroll }}
      searchTarget={{ ...target, outline: { top: .25 } }} onSearchResult={onSearchResult} />);
    await waitFor(() => expect(onSearchResult).toHaveBeenCalledWith({ status: "outline", matches: 0 }));
    expect(mocks.pages.get(2)!.searchTarget).toEqual({ ...target, outline: { top: .25 } });
  });
});
