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
  const [failedPages, setFailedPages] = useState<Set<number>>(new Set());
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

  const removePage = useCallback((pageNum: number) => {
    setRenderedPages((prev) => {
      if (!prev.has(pageNum)) return prev;
      const next = new Set(prev);
      next.delete(pageNum);
      return next;
    });
  }, []);

  const addFailedPage = useCallback((pageNum: number) => {
    setFailedPages((prev) => {
      if (prev.has(pageNum)) return prev;
      const next = new Set(prev);
      next.add(pageNum);
      return next;
    });
  }, []);

  const removeFailedPage = useCallback((pageNum: number) => {
    setFailedPages((prev) => {
      if (!prev.has(pageNum)) return prev;
      const next = new Set(prev);
      next.delete(pageNum);
      return next;
    });
  }, []);

  useEffect(() => {
    setRenderedPages(new Set([initialPage]));
    setFailedPages(new Set());
  }, [document, initialPage]);

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
      { rootMargin: "240px" }
    );

    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, [addPage]);

  useEffect(() => {
    const container = containerRef.current;
    const observer = observerRef.current;
    if (!container || !observer) return;

    observer.disconnect();
    container.querySelectorAll("[data-page-placeholder]").forEach((el) => {
      observer.observe(el);
    });
  }, [renderedPages, failedPages]);

  const handlePageRendered = (pageNum: number) => {
    onPageChange?.(pageNum);
  };

  const handlePageError = (pageNum: number) => {
    removePage(pageNum);
    addFailedPage(pageNum);
  };

  const handleRetryPage = (pageNum: number) => {
    removeFailedPage(pageNum);
    addPage(pageNum);
  };

  const handleManualPageLoad = (pageNum: number) => {
    addPage(pageNum);
  };

  const PAGE_HEIGHT = 800;
  const items = Array.from({ length: document.numPages }, (_, index) => {
    const pageNum = index + 1;
    if (failedPages.has(pageNum)) return { type: "failed" as const, pageNum, key: `failed-${pageNum}` };
    if (renderedPages.has(pageNum)) return { type: "page" as const, pageNum, key: `page-${pageNum}` };
    return { type: "placeholder" as const, pageNum, key: `placeholder-${pageNum}` };
  });

  return (
    <div ref={containerRef} className={`w-full ${className}`}>
      {items.map((item) => {
        if (item.type === "failed") {
          return (
            <div key={item.key} className="mb-6 flex items-center justify-center" style={{ height: PAGE_HEIGHT }}>
              <div className="text-center">
                <p className="text-lg text-ink mb-2">第 {item.pageNum} 页加载失败</p>
                <p className="text-sm text-muted mb-4">网络或渲染异常，可以单独重试本页</p>
                <button className="btn btn-outline text-sm cursor-pointer" onClick={() => handleRetryPage(item.pageNum)}>重试本页</button>
              </div>
            </div>
          );
        }

        if (item.type === "page") {
          return (
            <div key={item.key} className="mb-6">
              <div className="relative">
                <PdfPage
                  id={`page-${item.pageNum}`}
                  document={document}
                  pageNumber={item.pageNum}
                  scale={scale}
                  onRendered={() => handlePageRendered(item.pageNum)}
                  onError={() => handlePageError(item.pageNum)}
                />
              </div>
            </div>
          );
        }

        return (
          <div
            key={item.key}
            data-page={item.pageNum}
            data-page-placeholder
            className="mb-6 flex items-center justify-center border border-rule"
            style={{ height: PAGE_HEIGHT }}
            id={`page-empty-${item.pageNum}`}
          >
            <div className="text-center">
              <p className="text-lg text-ink mb-2">第 {item.pageNum} 页</p>
              <p className="text-sm text-muted mb-4">滚动到此处时加载</p>
              <button className="btn btn-outline text-sm cursor-pointer" onClick={() => handleManualPageLoad(item.pageNum)}>加载本页</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
