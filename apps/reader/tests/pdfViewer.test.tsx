import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { PdfViewer } from "../../../packages/pdf-viewer/src/PdfViewer";
import { getSafePdfRenderScale, MAX_PDF_CANVAS_PIXELS } from "../../../packages/pdf-viewer/src/PdfPage";

const textLayerMocks = vi.hoisted(() => ({
  instances: [] as Array<{ container: HTMLElement; viewport: unknown }>,
}));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  TextLayer: class MockTextLayer {
    private readonly container: HTMLElement;

    constructor({ container, viewport }: { container: HTMLElement; viewport: unknown }) {
      this.container = container;
      textLayerMocks.instances.push({ container, viewport });
    }

    async render() {
      const span = window.document.createElement("span");
      span.textContent = "可复制文本";
      this.container.append(span);
    }

    cancel() {}
  },
}));

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

async function renderViewer(document: PDFDocumentProxy, initialPage = 1, suppressPageLoading = false) {
  const host = window.document.createElement("div");
  window.document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<PdfViewer document={document} initialPage={initialPage} suppressPageLoading={suppressPageLoading} />);
  });
  return {
    host,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

function dispatchPointer(
  element: Element,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  init: { pointerId: number; clientX: number; clientY: number; pointerType?: string },
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId },
    pointerType: { value: init.pointerType ?? "touch" },
    clientX: { value: init.clientX },
    clientY: { value: init.clientY },
    button: { value: 0 },
    shiftKey: { value: false },
  });
  element.dispatchEvent(event);
}

beforeEach(() => {
  observers.length = 0;
  textLayerMocks.instances.length = 0;
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.document.body.innerHTML = "";
});

describe("PdfViewer demand loading", () => {
  it("shows a full-height page loading state before the first canvas resolves", async () => {
    const { document } = createDocument(1);
    const view = await renderViewer(document);

    expect(view.host.textContent).toContain("正在加载第 1 页");
    expect(view.host.querySelector("[data-pdf-page-content]")?.className).toContain("h-full");
    const loadingMessage = view.host.querySelector("[data-pdf-page-loading] > div");
    expect(loadingMessage?.className).toContain("sticky");
    expect(loadingMessage?.className).toContain("top-[50vh]");
    expect(loadingMessage?.className).toContain("-translate-y-1/2");

    await view.unmount();
  });

  it("suppresses the page-level loading prompt while a parent overlay is visible", async () => {
    const { document } = createDocument(1);
    const view = await renderViewer(document, 1, true);

    expect(view.host.querySelector("[data-pdf-page-loading]")).toBeNull();

    await view.unmount();
  });

  it("renders an aligned selectable text layer for loaded pages", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
    const streamTextContent = vi.fn(() => new ReadableStream());
    const page = {
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
        scale,
        rotation: 0,
        rawDims: { pageWidth: 600, pageHeight: 800, pageX: 0, pageY: 0 },
      }),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      streamTextContent,
      cleanup: vi.fn(),
    };
    const document = {
      numPages: 1,
      getPage: vi.fn().mockResolvedValue(page),
    } as unknown as PDFDocumentProxy;
    const view = await renderViewer(document);

    await vi.waitFor(() => {
      expect(view.host.querySelector("[data-pdf-text-layer] span")?.textContent).toBe("可复制文本");
    });
    expect(streamTextContent).toHaveBeenCalledWith({
      includeMarkedContent: true,
      disableNormalization: true,
    });
    expect(textLayerMocks.instances).toHaveLength(1);
    expect(textLayerMocks.instances[0]?.container.style.getPropertyValue("--total-scale-factor")).toBe("0.5");
    expect(textLayerMocks.instances[0]?.container.style.getPropertyValue("--scale-round-x")).toBe("1px");
    expect(textLayerMocks.instances[0]?.container.style.getPropertyValue("--scale-round-y")).toBe("1px");

    await view.unmount();
  });

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

  it("renders ahead for smooth high-resolution zoom without exceeding canvas limits", () => {
    const base = {
      pageWidth: 600,
      pageHeight: 800,
      containerWidth: 300,
      devicePixelRatio: 2,
      quality: 3,
    };

    const fittedScale = getSafePdfRenderScale(base);
    const zoomReadyScale = getSafePdfRenderScale({ ...base, renderZoom: 3 });

    expect(zoomReadyScale).toBeGreaterThan(fittedScale);
    expect(base.pageWidth * zoomReadyScale * base.pageHeight * zoomReadyScale)
      .toBeLessThanOrEqual(MAX_PDF_CANVAS_PIXELS + 1);
  });

  it("uses zoom-ready layout and starts a continuous pinch gesture from reading mode", async () => {
    const { document } = createDocument(1);
    const scrollContainer = window.document.createElement("div");
    const host = window.document.createElement("div");
    scrollContainer.append(host);
    window.document.body.append(scrollContainer);
    const root = createRoot(host);
    const onZoomChange = vi.fn();
    const onZoomEnabledChange = vi.fn();

    await act(async () => {
      root.render(
        <PdfViewer
          document={document}
          zoom={1.5}
          onZoomChange={onZoomChange}
          onZoomEnabledChange={onZoomEnabledChange}
          scrollContainerRef={{ current: scrollContainer }}
        />,
      );
    });

    const zoomContent = host.querySelector<HTMLElement>("[data-pdf-zoom-content]")!;
    expect(zoomContent.style.width).toBe("100%");
    expect(zoomContent.style.touchAction).toBe("pan-y");

    await act(async () => {
      dispatchPointer(zoomContent, "pointerdown", { pointerId: 1, clientX: 100, clientY: 120 });
      dispatchPointer(zoomContent, "pointerdown", { pointerId: 2, clientX: 200, clientY: 120 });
      dispatchPointer(zoomContent, "pointermove", { pointerId: 2, clientX: 300, clientY: 120 });
      dispatchPointer(zoomContent, "pointermove", { pointerId: 2, clientX: 200, clientY: 120 });
      dispatchPointer(zoomContent, "pointerup", { pointerId: 2, clientX: 200, clientY: 120 });
    });

    expect(onZoomEnabledChange).toHaveBeenNthCalledWith(1, true);
    expect(onZoomChange).toHaveBeenNthCalledWith(1, 1);
    expect(onZoomChange).toHaveBeenNthCalledWith(2, 2);
    expect(onZoomChange).toHaveBeenLastCalledWith(1);
    expect(onZoomEnabledChange).toHaveBeenLastCalledWith(false);

    await act(async () => root.unmount());
    scrollContainer.remove();
  });
});
