import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { PdfViewer } from "../../../packages/pdf-viewer/src/PdfViewer";
import { getSafePdfRenderScale, MAX_PDF_CANVAS_PIXELS } from "../../../packages/pdf-viewer/src/PdfPage";

interface ObserverRecord {
  callback: IntersectionObserverCallback;
  options?: IntersectionObserverInit;
  elements: Set<Element>;
}

const observers: ObserverRecord[] = [];

class MockIntersectionObserver {
  readonly root: Element | Document | null = null;
  readonly rootMargin = "0px";
  readonly thresholds: readonly number[] = [0];
  private readonly record: ObserverRecord;

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.record = { callback, options, elements: new Set() };
    observers.push(this.record);
  }

  observe = (element: Element) => this.record.elements.add(element);
  unobserve = (element: Element) => this.record.elements.delete(element);
  disconnect = () => this.record.elements.clear();
  takeRecords = (): IntersectionObserverEntry[] => [];
}

function createDocument(numPages: number) {
  const getPage = vi.fn(() => new Promise(() => {}));
  return {
    document: { numPages, getPage } as unknown as PDFDocumentProxy,
    getPage,
  };
}

async function renderViewer(document: PDFDocumentProxy, initialPage = 1) {
  const host = window.document.createElement("div");
  window.document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<PdfViewer document={document} initialPage={initialPage} />);
  });
  return {
    host,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.document.body.innerHTML = "";
});

describe("PdfViewer demand loading", () => {
  it("keeps an observable lightweight slot for every page", async () => {
    const { document, getPage } = createDocument(100);
    const view = await renderViewer(document);

    expect(view.host.querySelectorAll("[data-pdf-page]")).toHaveLength(100);
    expect(view.host.querySelector("#page-100")).not.toBeNull();
    expect(view.host.querySelector("[data-page-state='placeholder']")).not.toBeNull();
    expect((view.host.querySelector("#page-1") as HTMLElement).style.minHeight).toBe("");
    expect((view.host.querySelector("#page-1") as HTMLElement).style.aspectRatio).not.toBe("");
    expect(getPage).toHaveBeenCalledWith(1);

    await view.unmount();
  });

  it("loads a far page when fast scrolling brings its slot into range", async () => {
    const { document, getPage } = createDocument(100);
    const view = await renderViewer(document);
    const page80 = view.host.querySelector("#page-80");
    const loadingObserver = observers.find((observer) => observer.options?.rootMargin === "25% 0px");

    expect(page80).not.toBeNull();
    expect(loadingObserver?.elements.has(page80!)).toBe(true);

    await act(async () => {
      loadingObserver?.callback([
        {
          target: page80!,
          isIntersecting: true,
          boundingClientRect: { top: 100, bottom: 900 },
        } as IntersectionObserverEntry,
      ], {} as IntersectionObserver);
    });

    expect(getPage).toHaveBeenCalledWith(80);
    expect(view.host.querySelector("#page-80")?.getAttribute("data-page-state")).toBe("loaded");

    await act(async () => {
      loadingObserver?.callback([
        {
          target: page80!,
          isIntersecting: false,
          boundingClientRect: { top: -2_000, bottom: -1_200 },
        } as IntersectionObserverEntry,
      ], {} as IntersectionObserver);
    });

    expect(view.host.querySelector("#page-80")?.getAttribute("data-page-state")).toBe("placeholder");
    expect(view.host.querySelector("#page-80 canvas")).toBeNull();

    await view.unmount();
  });

  it("clamps an invalid initial page instead of rendering a blank document", async () => {
    const { document, getPage } = createDocument(12);
    const view = await renderViewer(document, 500);

    expect(getPage).toHaveBeenCalledWith(12);
    expect(view.host.querySelector("#page-12")?.getAttribute("data-page-state")).toBe("loaded");

    await view.unmount();
  });

  it("caps oversized render requests to a safe canvas pixel budget", () => {
    const pageWidth = 1_065;
    const pageHeight = 1_501;
    const scale = getSafePdfRenderScale({
      pageWidth,
      pageHeight,
      containerWidth: 1_248,
      devicePixelRatio: 2,
      requestedScale: 10,
    });

    expect(pageWidth * scale * pageHeight * scale).toBeLessThanOrEqual(MAX_PDF_CANVAS_PIXELS + 1);
    expect(scale).toBeLessThan(10);
  });

  it("caps automatic device pixel ratio at two", () => {
    const base = {
      pageWidth: 600,
      pageHeight: 800,
      containerWidth: 300,
    };

    expect(getSafePdfRenderScale({ ...base, devicePixelRatio: 4 }))
      .toBe(getSafePdfRenderScale({ ...base, devicePixelRatio: 2 }));
  });

  it("uses quality three as the highest useful reader quality", () => {
    const base = {
      pageWidth: 1_065,
      pageHeight: 1_501,
      containerWidth: 1_248,
      devicePixelRatio: 1,
    };
    const standard = getSafePdfRenderScale({ ...base, quality: 1 });
    const highest = getSafePdfRenderScale({ ...base, quality: 3 });

    expect(highest).toBeGreaterThan(standard);
    expect(base.pageWidth * highest * base.pageHeight * highest).toBeLessThanOrEqual(MAX_PDF_CANVAS_PIXELS + 1);
  });

  it("keeps all three explicit quality levels distinct on high-DPR screens", () => {
    const base = {
      pageWidth: 600,
      pageHeight: 800,
      containerWidth: 300,
      devicePixelRatio: 3,
    };

    const qualityOne = getSafePdfRenderScale({ ...base, quality: 1 });
    const qualityTwo = getSafePdfRenderScale({ ...base, quality: 2 });
    const qualityThree = getSafePdfRenderScale({ ...base, quality: 3 });

    expect(qualityTwo).toBeGreaterThan(qualityOne);
    expect(qualityThree).toBeGreaterThan(qualityTwo);
  });
});
