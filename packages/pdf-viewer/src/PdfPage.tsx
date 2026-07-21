import { useRef, useEffect, useState } from "react";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import { TextLayer } from "pdfjs-dist/legacy/build/pdf.mjs";
import "./textLayer.css";

export const MAX_PDF_CANVAS_PIXELS = 32_000_000;
export const MAX_PDF_CANVAS_DIMENSION = 8_192;
const MAX_AUTO_DEVICE_PIXEL_RATIO = 2;

interface PdfPageMetrics {
  width: number;
  height: number;
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
  className?: string;
  onRendered?: (pageNumber: number) => void;
  onPageMetrics?: (pageNumber: number, metrics: PdfPageMetrics) => void;
  onError?: (pageNumber: number, error: Error) => void;
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
  className = "",
  onRendered,
  onPageMetrics,
  onError,
}: PdfPageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [rendering, setRendering] = useState(true);
  const [containerWidth, setContainerWidth] = useState(0);
  const renderTask = useRef<RenderTask | null>(null);
  const textLayerTask = useRef<{ cancel: () => void } | null>(null);
  const layoutZoomRef = useRef(Math.max(layoutZoom, 1));
  const callbacksRef = useRef({ onRendered, onPageMetrics, onError });
  layoutZoomRef.current = Math.max(layoutZoom, 1);

  useEffect(() => {
    callbacksRef.current = { onRendered, onPageMetrics, onError };
  }, [onError, onPageMetrics, onRendered]);

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
    setRendering(true);

    const render = async () => {
      try {
        page = await document.getPage(pageNumber);
        if (disposed) return;

        const baseViewport = page.getViewport({ scale: 1 });
        callbacksRef.current.onPageMetrics?.(pageNumber, { width: baseViewport.width, height: baseViewport.height });
        const renderScale = getSafePdfRenderScale({
          pageWidth: baseViewport.width,
          pageHeight: baseViewport.height,
          containerWidth,
          devicePixelRatio: window.devicePixelRatio,
          requestedScale: scale,
          quality,
          renderZoom,
        });
        const viewport = page.getViewport({ scale: renderScale });
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        canvas.style.width = "100%";
        canvas.style.height = "auto";

        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas 2D context is unavailable");

        const task = page.render({ canvas, canvasContext: context, viewport });
        renderTask.current = task;
        await task.promise;
        if (disposed) return;

        setRendering(false);
        callbacksRef.current.onRendered?.(pageNumber);
      } catch (error) {
        if (disposed || (error as { name?: string })?.name === "RenderingCancelledException") return;
        setRendering(false);
        callbacksRef.current.onError?.(pageNumber, error instanceof Error ? error : new Error(String(error)));
      }
    };

    void render();

    return () => {
      disposed = true;
      renderTask.current?.cancel();
      renderTask.current = null;
      page?.cleanup();
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [containerWidth, document, pageNumber, quality, renderZoom, scale]);

  useEffect(() => {
    const container = containerRef.current;
    const textLayerContainer = textLayerRef.current;
    if (!enableTextLayer || !container || !textLayerContainer || !document || containerWidth === 0) {
      textLayerTask.current?.cancel();
      textLayerTask.current = null;
      textLayerContainer?.replaceChildren();
      return;
    }

    let disposed = false;

    const renderText = async () => {
      try {
        const page = await document.getPage(pageNumber);
        if (disposed) return;

        const baseViewport = page.getViewport({ scale: 1 });
        const layoutWidth = Math.max(container.clientWidth, containerWidth * Math.max(layoutZoom, 1));
        const viewport = page.getViewport({ scale: layoutWidth / Math.max(baseViewport.width, 1) });
        textLayerTask.current?.cancel();
        textLayerContainer.replaceChildren();
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
      textLayerContainer.replaceChildren();
    };
  }, [containerWidth, document, enableTextLayer, layoutZoom, pageNumber]);

  return (
    <div ref={containerRef} id={id} data-pdf-page-content className={`relative h-full ${className}`}>
      <canvas ref={canvasRef} className="block w-full h-auto" />
      {enableTextLayer ? (
        <div ref={textLayerRef} className="textLayer" data-pdf-text-layer />
      ) : null}
      {rendering && (
        <div className="absolute inset-0 z-10 bg-paper/85" data-pdf-page-loading>
          <div className="sticky top-[50vh] flex -translate-y-1/2 items-center justify-center gap-2.5 py-6">
            <div className="w-4 h-4 border-2 border-red border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-ink">正在加载第 {pageNumber} 页</span>
          </div>
        </div>
      )}
    </div>
  );
}
