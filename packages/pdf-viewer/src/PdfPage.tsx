import { useRef, useEffect, useState } from "react";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";

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
}: {
  pageWidth: number;
  pageHeight: number;
  containerWidth: number;
  devicePixelRatio?: number;
  requestedScale?: number;
  quality?: number;
}): number {
  const safePageWidth = Math.max(pageWidth, 1);
  const safePageHeight = Math.max(pageHeight, 1);
  const fitScale = containerWidth > 0 ? containerWidth / safePageWidth : 1;
  const outputPixelRatio = quality && quality > 0
    ? quality
    : Math.min(Math.max(devicePixelRatio, 1), MAX_AUTO_DEVICE_PIXEL_RATIO);
  const targetScale = requestedScale && requestedScale > 0 ? requestedScale : fitScale * outputPixelRatio;
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
  className = "",
  onRendered,
  onPageMetrics,
  onError,
}: PdfPageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [rendering, setRendering] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);
  const renderTask = useRef<RenderTask | null>(null);
  const callbacksRef = useRef({ onRendered, onPageMetrics, onError });

  useEffect(() => {
    callbacksRef.current = { onRendered, onPageMetrics, onError };
  }, [onError, onPageMetrics, onRendered]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measure = () => {
      const width = container.getBoundingClientRect().width;
      setContainerWidth(width > 0 ? width : -1);
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
  }, [containerWidth, document, pageNumber, quality, scale]);

  return (
    <div ref={containerRef} id={id} className={`relative ${className}`}>
      <canvas ref={canvasRef} className="block w-full h-auto" />
      {rendering && (
        <div className="absolute inset-0 flex items-center justify-center gap-2.5 bg-paper/85">
          <div className="w-4 h-4 border-2 border-red border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-ink">正在加载第 {pageNumber} 页</span>
        </div>
      )}
    </div>
  );
}
