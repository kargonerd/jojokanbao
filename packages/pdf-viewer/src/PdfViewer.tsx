import { useState, useRef, useEffect, useCallback } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { PdfPage } from "./PdfPage";

interface PdfViewerProps {
  document: PDFDocumentProxy;
  initialPage?: number;
  scale?: number;
  className?: string;
  onPageChange?: (page: number) => void;
}

export function PdfViewer({ document, initialPage = 1, scale = 2, className = "", onPageChange }: PdfViewerProps) {
  const [renderedPages, setRenderedPages] = useState<Set<number>>(new Set([initialPage]));
  const containerRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  const addPage = useCallback((pageNum: number) => {
    if (pageNum < 1 || pageNum > document.numPages) return;
    setRenderedPages((prev) => {
      if (prev.has(pageNum)) return prev;
      const next = new Set(prev);
      next.add(pageNum);
      return next;
    });
  }, [document.numPages]);

  // Lazy load pages as they enter viewport
  useEffect(() => {
    observerRef.current = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const pageNum = Number(entry.target.getAttribute("data-page"));
            if (pageNum) addPage(pageNum);
          }
        });
      },
      { rootMargin: "200px" }
    );
    return () => { observerRef.current?.disconnect(); };
  }, [addPage]);

  // Observe placeholder elements
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !observerRef.current) return;
    container.querySelectorAll("[data-page-placeholder]").forEach((el) => {
      observerRef.current!.observe(el);
    });
  }, [renderedPages]);

  const handlePageRendered = (pageNum: number) => {
    // Pre-load adjacent pages
    addPage(pageNum + 1);
    addPage(pageNum + 2);
    onPageChange?.(pageNum);
  };

  const sortedPages = Array.from(renderedPages).sort((a, b) => a - b);

  return (
    <div ref={containerRef} className={`w-full ${className}`}>
      {Array.from({ length: document.numPages }, (_, i) => i + 1).map((pageNum) =>
        sortedPages.includes(pageNum) ? (
          <div key={pageNum} className="mb-6" id={`page-${pageNum}`}>
            <PdfPage document={document} pageNumber={pageNum} scale={scale} onRendered={handlePageRendered} />
          </div>
        ) : (
          <div
            key={pageNum}
            data-page={pageNum}
            data-page-placeholder
            className="mb-6 flex items-center justify-center h-[600px] border border-rule"
            id={`page-${pageNum}`}
          >
            <p className="text-sm text-muted">第 {pageNum} 页</p>
          </div>
        )
      )}
    </div>
  );
}
