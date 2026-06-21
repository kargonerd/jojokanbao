import { useRef, useEffect, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";

interface PdfPageProps {
  id?: string;
  document: PDFDocumentProxy;
  pageNumber: number;
  scale?: number;
  className?: string;
  onRendered?: (pageNumber: number) => void;
  onError?: (pageNumber: number, error: Error) => void;
}

export function PdfPage({ id, document, pageNumber, scale = 2, className = "", onRendered, onError }: PdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [rendering, setRendering] = useState(false);
  const renderTask = useRef<any>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !document) return;

    setRendering(true);

    document.getPage(pageNumber).then((page) => {
      const viewport = page.getViewport({ scale });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = "100%";
      canvas.style.height = "auto";

      const ctx = canvas.getContext("2d")!;
      if (renderTask.current) {
        renderTask.current.cancel();
      }

      renderTask.current = page.render({ canvas, canvasContext: ctx, viewport });
      renderTask.current.promise
        .then(() => { setRendering(false); onRendered?.(pageNumber); })
        .catch((err: any) => {
          if (err?.name !== "RenderingCancelledException") {
            setRendering(false);
            onError?.(pageNumber, err);
          }
        });
    }).catch((err) => {
      setRendering(false);
      onError?.(pageNumber, err);
    });

    return () => { renderTask.current?.cancel(); };
  }, [document, pageNumber, scale]);

  return (
    <div id={id} className={`relative ${className}`}>
      <canvas ref={canvasRef} />
      {rendering && (
        <div className="absolute inset-0 flex items-center justify-center gap-2.5 bg-paper/85">
          <div className="w-4 h-4 border-2 border-red border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-ink">正在加载第 {pageNumber} 页</span>
        </div>
      )}
    </div>
  );
}
