import { useRef, useEffect, useState } from "react";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import { TextLayer } from "pdfjs-dist/legacy/build/pdf.mjs";
import "./textLayer.css";
import { bindPdfTextLayerSelection } from "./textLayerSelection";

export const MAX_PDF_CANVAS_PIXELS = 32_000_000;
export const MAX_PDF_CANVAS_DIMENSION = 8_192;
const MAX_AUTO_DEVICE_PIXEL_RATIO = 2;

export interface PdfPageMetrics {
  width: number;
  height: number;
}

export interface PdfPageReferenceMetrics extends PdfPageMetrics {
  rotation: number;
}

interface PdfContentBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface PdfPageProps {
  id?: string;
  document: PDFDocumentProxy;
  pageNumber: number;
  scale?: number;
  quality?: number;
  renderZoom?: number;
  layoutZoom?: number;
  enableTextLayer?: boolean;
  showLoading?: boolean;
  className?: string;
  onRendered?: (pageNumber: number) => void;
  onPageMetrics?: (pageNumber: number, metrics: PdfPageMetrics) => void;
  onError?: (pageNumber: number, error: Error) => void;
}

interface RecordedPdfOperationBounds {
  length: number;
  isEmpty: (index: number) => boolean;
  minX: (index: number) => number;
  minY: (index: number) => number;
  maxX: (index: number) => number;
  maxY: (index: number) => number;
}

const OVERSIZED_PAGE_WIDTH_RATIO = 1.75;
const REFERENCE_PAGE_HEIGHT_TOLERANCE = 0.15;
const CONTENT_LEFT_EDGE_TOLERANCE = 0.08;
const CONTENT_RIGHT_EDGE_TOLERANCE = 0.08;
const CONTENT_BOUNDS_MAX_DIMENSION = 512;
const referencePageMetricsCache = new WeakMap<PDFDocumentProxy, Promise<PdfPageReferenceMetrics | null>>();

function getReferencePageMetrics(document: PDFDocumentProxy): Promise<PdfPageReferenceMetrics | null> {
  const cached = referencePageMetricsCache.get(document);
  if (cached) return cached;

  const metrics = document.getPage(1)
    .then((page) => {
      const viewport = page.getViewport({ scale: 1 });
      if (!(viewport.width > 0) || !(viewport.height > 0)) return null;
      return {
        width: viewport.width,
        height: viewport.height,
        rotation: viewport.rotation,
      };
    })
    .catch(() => null);
  referencePageMetricsCache.set(document, metrics);
  return metrics;
}

function getRecordedContentBounds(page: PDFPageProxy): PdfContentBounds | null {
  const bounds = page.recordedBBoxes as RecordedPdfOperationBounds | null;
  if (!bounds || !(bounds.length > 0)) return null;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < bounds.length; index += 1) {
    if (bounds.isEmpty(index)) continue;
    minX = Math.min(minX, bounds.minX(index));
    minY = Math.min(minY, bounds.minY(index));
    maxX = Math.max(maxX, bounds.maxX(index));
    maxY = Math.max(maxY, bounds.maxY(index));
  }

  if (![minX, minY, maxX, maxY].every(Number.isFinite) || minX >= maxX || minY >= maxY) {
    return null;
  }
  return { minX, minY, maxX, maxY };
}

export function getOversizedPdfPageCrop({
  pageWidth,
  pageHeight,
  pageRotation,
  referencePage,
  contentBounds,
}: {
  pageWidth: number;
  pageHeight: number;
  pageRotation: number;
  referencePage?: PdfPageReferenceMetrics | null;
  contentBounds?: PdfContentBounds | null;
}): PdfPageMetrics | null {
  if (!referencePage || !contentBounds || pageRotation % 360 !== referencePage.rotation % 360) return null;
  if (!(referencePage.width > 0) || !(referencePage.height > 0)) return null;

  const widthRatio = pageWidth / referencePage.width;
  const heightRatio = pageHeight / referencePage.height;
  if (
    widthRatio < OVERSIZED_PAGE_WIDTH_RATIO
    || Math.abs(heightRatio - 1) > REFERENCE_PAGE_HEIGHT_TOLERANCE
  ) {
    return null;
  }

  const normalizedMinX = Math.max(0, contentBounds.minX);
  const normalizedMaxX = Math.min(1, contentBounds.maxX);
  const contentRight = normalizedMaxX * pageWidth;
  if (
    normalizedMinX > CONTENT_LEFT_EDGE_TOLERANCE
    || contentRight > referencePage.width * (1 + CONTENT_RIGHT_EDGE_TOLERANCE)
  ) {
    return null;
  }

  return {
    width: Math.min(Math.max(referencePage.width, contentRight), pageWidth),
    height: pageHeight,
  };
}

function isPotentiallyOversizedPdfPage(
  pageMetrics: PdfPageReferenceMetrics,
  referencePage?: PdfPageReferenceMetrics | null,
): boolean {
  if (!referencePage || pageMetrics.rotation % 360 !== referencePage.rotation % 360) return false;
  if (!(referencePage.width > 0) || !(referencePage.height > 0)) return false;
  return pageMetrics.width / referencePage.width >= OVERSIZED_PAGE_WIDTH_RATIO
    && Math.abs(pageMetrics.height / referencePage.height - 1) <= REFERENCE_PAGE_HEIGHT_TOLERANCE;
}

export function getSafePdfRenderScale({
  pageWidth,
  pageHeight,
  containerWidth,
  devicePixelRatio = 1,
  requestedScale,
  quality,
  renderZoom = 1,
}: {
  pageWidth: number;
  pageHeight: number;
  containerWidth: number;
  devicePixelRatio?: number;
  requestedScale?: number;
  quality?: number;
  renderZoom?: number;
}): number {
  const safePageWidth = Math.max(pageWidth, 1);
  const safePageHeight = Math.max(pageHeight, 1);
  const fitScale = containerWidth > 0 ? containerWidth / safePageWidth : 1;
  const outputPixelRatio = quality && quality > 0
    ? quality
    : Math.min(Math.max(devicePixelRatio, 1), MAX_AUTO_DEVICE_PIXEL_RATIO);
  const outputZoom = Math.max(renderZoom, 1);
  const targetScale = requestedScale && requestedScale > 0
    ? requestedScale
    : fitScale * outputPixelRatio * outputZoom;
  const pixelLimitScale = Math.sqrt(MAX_PDF_CANVAS_PIXELS / (safePageWidth * safePageHeight));
  const dimensionLimitScale = Math.min(
    MAX_PDF_CANVAS_DIMENSION / safePageWidth,
    MAX_PDF_CANVAS_DIMENSION / safePageHeight,
  );

  return Math.max(0.1, Math.min(targetScale, pixelLimitScale, dimensionLimitScale));
}

export function PdfPage({
  id,
  document,
  pageNumber,
  scale,
  quality,
  renderZoom,
  layoutZoom = 1,
  enableTextLayer = true,
  showLoading = true,
  className = "",
  onRendered,
  onPageMetrics,
  onError,
}: PdfPageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [rendering, setRendering] = useState(true);
  const [canvasReady, setCanvasReady] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);
  const [displayMetrics, setDisplayMetrics] = useState<PdfPageMetrics | null>(null);
  const renderTask = useRef<RenderTask | null>(null);
  const textLayerTask = useRef<{ cancel: () => void } | null>(null);
  const textLayerSelectionCleanup = useRef<(() => void) | null>(null);
  const hasRenderedRef = useRef(false);
  const layoutZoomRef = useRef(Math.max(layoutZoom, 1));
  const callbacksRef = useRef({ onRendered, onPageMetrics, onError });
  layoutZoomRef.current = Math.max(layoutZoom, 1);

  useEffect(() => {
    callbacksRef.current = { onRendered, onPageMetrics, onError };
  }, [onError, onPageMetrics, onRendered]);

  useEffect(() => () => {
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    hasRenderedRef.current = false;
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measure = () => {
      // The viewer expands layout width so WebKit exposes the full scroll area.
      // Normalize it back to the fit width so zoom never retriggers PDF.js.
      const width = container.clientWidth / layoutZoomRef.current;
      setContainerWidth((previous) => (
        previous > 0 && Math.abs(previous - width) < 1 ? previous : width > 0 ? width : -1
      ));
    };
    measure();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !document || containerWidth === 0) return;

    let disposed = false;
    let page: PDFPageProxy | null = null;
    let renderCanvas: HTMLCanvasElement | null = null;
    if (!hasRenderedRef.current) setRendering(true);

    const render = async () => {
      try {
        const [loadedPage, referencePageMetrics] = await Promise.all([
          document.getPage(pageNumber),
          getReferencePageMetrics(document),
        ]);
        page = loadedPage;
        if (disposed) return;

        const baseViewport = page.getViewport({ scale: 1 });
        const pageMetrics: PdfPageReferenceMetrics = {
          width: baseViewport.width,
          height: baseViewport.height,
          rotation: baseViewport.rotation,
        };
        let nextDisplayMetrics: PdfPageMetrics = pageMetrics;

        if (isPotentiallyOversizedPdfPage(pageMetrics, referencePageMetrics)) {
          const analysisScale = Math.min(
            1,
            CONTENT_BOUNDS_MAX_DIMENSION / Math.max(baseViewport.width, baseViewport.height, 1),
          );
          const analysisViewport = page.getViewport({ scale: analysisScale });
          const analysisCanvas = window.document.createElement("canvas");
          analysisCanvas.width = Math.max(1, Math.ceil(analysisViewport.width));
          analysisCanvas.height = Math.max(1, Math.ceil(analysisViewport.height));
          const analysisContext = analysisCanvas.getContext("2d");
          let contentBounds: PdfContentBounds | null = null;
          let analysisTask: RenderTask | null = null;

          if (analysisContext) {
            try {
              analysisTask = page.render({
                canvas: analysisCanvas,
                canvasContext: analysisContext,
                viewport: analysisViewport,
                recordOperations: true,
              });
              renderTask.current = analysisTask;
              await analysisTask.promise;
              if (disposed) return;
              contentBounds = getRecordedContentBounds(page);
            } catch (error) {
              if (disposed || (error as { name?: string })?.name === "RenderingCancelledException") return;
              // Content-bound analysis is an enhancement. If PDF.js cannot
              // record one page, render its original dimensions instead.
            } finally {
              if (renderTask.current === analysisTask) renderTask.current = null;
              analysisCanvas.width = 0;
              analysisCanvas.height = 0;
            }
          } else {
            analysisCanvas.width = 0;
            analysisCanvas.height = 0;
          }

          nextDisplayMetrics = getOversizedPdfPageCrop({
            pageWidth: baseViewport.width,
            pageHeight: baseViewport.height,
            pageRotation: baseViewport.rotation,
            referencePage: referencePageMetrics,
            contentBounds,
          }) ?? pageMetrics;
        }

        setDisplayMetrics((previous) => (
          previous?.width === nextDisplayMetrics.width && previous.height === nextDisplayMetrics.height
            ? previous
            : nextDisplayMetrics
        ));
        callbacksRef.current.onPageMetrics?.(pageNumber, nextDisplayMetrics);
        const renderScale = getSafePdfRenderScale({
          pageWidth: nextDisplayMetrics.width,
          pageHeight: nextDisplayMetrics.height,
          containerWidth,
          devicePixelRatio: window.devicePixelRatio,
          requestedScale: scale,
          quality,
          renderZoom,
        });
        const viewport = page.getViewport({ scale: renderScale });
        renderCanvas = window.document.createElement("canvas");
        renderCanvas.width = Math.max(1, Math.floor(nextDisplayMetrics.width * renderScale));
        renderCanvas.height = Math.max(1, Math.floor(nextDisplayMetrics.height * renderScale));
        const context = renderCanvas.getContext("2d");
        if (!context) throw new Error("Canvas 2D context is unavailable");

        const task = page.render({ canvas: renderCanvas, canvasContext: context, viewport });
        renderTask.current = task;
        await task.promise;
        if (disposed) return;

        const visibleContext = canvas.getContext("2d");
        if (!visibleContext) throw new Error("Canvas 2D context is unavailable");
        canvas.width = renderCanvas.width;
        canvas.height = renderCanvas.height;
        canvas.style.width = "100%";
        canvas.style.height = "auto";
        visibleContext.drawImage(renderCanvas, 0, 0);
        renderCanvas.width = 0;
        renderCanvas.height = 0;
        hasRenderedRef.current = true;
        setCanvasReady(true);
        setRendering(false);
        callbacksRef.current.onRendered?.(pageNumber);
      } catch (error) {
        if (disposed || (error as { name?: string })?.name === "RenderingCancelledException") return;
        setRendering(false);
        if (!hasRenderedRef.current) {
          callbacksRef.current.onError?.(pageNumber, error instanceof Error ? error : new Error(String(error)));
        }
      }
    };

    void render();

    return () => {
      disposed = true;
      renderTask.current?.cancel();
      renderTask.current = null;
      if (renderCanvas) {
        renderCanvas.width = 0;
        renderCanvas.height = 0;
      }
      page?.cleanup();
    };
  }, [containerWidth, document, pageNumber, quality, renderZoom, scale]);

  useEffect(() => {
    const container = containerRef.current;
    const textLayerContainer = textLayerRef.current;
    if (!enableTextLayer || !canvasReady || !container || !textLayerContainer || !document || containerWidth === 0) {
      textLayerTask.current?.cancel();
      textLayerTask.current = null;
      textLayerSelectionCleanup.current?.();
      textLayerSelectionCleanup.current = null;
      textLayerContainer?.replaceChildren();
      return;
    }

    let disposed = false;

    const renderText = async () => {
      try {
        const page = await document.getPage(pageNumber);
        if (disposed) return;

        const baseViewport = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({
          scale: containerWidth / Math.max(displayMetrics?.width ?? baseViewport.width, 1),
        });
        textLayerTask.current?.cancel();
        textLayerSelectionCleanup.current?.();
        textLayerSelectionCleanup.current = null;
        textLayerContainer.replaceChildren();
        // PDF.js positions spans as percentages but sizes their fonts and layer
        // dimensions through these page-level variables. Without the viewport
        // scale, selectable text collapses into the wrong columns even though
        // the canvas itself remains visually correct.
        textLayerContainer.style.setProperty("--total-scale-factor", String(viewport.scale));
        textLayerContainer.style.setProperty("--scale-round-x", "1px");
        textLayerContainer.style.setProperty("--scale-round-y", "1px");
        const task = new TextLayer({
          textContentSource: page.streamTextContent({
            includeMarkedContent: true,
            disableNormalization: true,
          }),
          container: textLayerContainer,
          viewport,
        });
        textLayerTask.current = task;
        await task.render();
        if (disposed) return;

        const endOfContent = window.document.createElement("div");
        endOfContent.className = "endOfContent";
        textLayerContainer.append(endOfContent);
        textLayerSelectionCleanup.current = bindPdfTextLayerSelection(textLayerContainer, endOfContent);
      } catch (error) {
        if (disposed || (error as { name?: string })?.name === "AbortException") return;
        textLayerContainer.replaceChildren();
      }
    };

    void renderText();
    return () => {
      disposed = true;
      textLayerTask.current?.cancel();
      textLayerTask.current = null;
      textLayerSelectionCleanup.current?.();
      textLayerSelectionCleanup.current = null;
      textLayerContainer.replaceChildren();
      textLayerContainer.style.removeProperty("--total-scale-factor");
      textLayerContainer.style.removeProperty("--scale-round-x");
      textLayerContainer.style.removeProperty("--scale-round-y");
    };
  }, [canvasReady, containerWidth, displayMetrics, document, enableTextLayer, pageNumber]);

  return (
    <div ref={containerRef} id={id} data-pdf-page-content className={`relative h-full overflow-hidden ${className}`}>
      <canvas ref={canvasRef} className="block w-full h-auto" data-pdf-render-zoom={renderZoom ?? 1} />
      {enableTextLayer ? (
        <div
          className="absolute left-0 top-0 origin-top-left will-change-transform"
          style={{
            width: `${100 / Math.max(layoutZoom, 1)}%`,
            height: `${100 / Math.max(layoutZoom, 1)}%`,
            transform: `scale(${Math.max(layoutZoom, 1)})`,
          }}
          data-pdf-text-layer-scale
        >
          <div ref={textLayerRef} className="textLayer" data-pdf-text-layer />
        </div>
      ) : null}
      {rendering && showLoading && (
        <div className="absolute inset-0 z-10 bg-paper/85" data-pdf-page-loading>
          <div
            className="sticky left-0 top-[50vh] flex -translate-y-1/2 items-center justify-center gap-2.5 py-6"
            style={{ width: `${100 / Math.max(layoutZoom, 1)}%` }}
            data-pdf-page-loading-message
          >
            <div className="w-4 h-4 border-2 border-red border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-ink">正在加载第 {pageNumber} 页</span>
          </div>
        </div>
      )}
    </div>
  );
}
