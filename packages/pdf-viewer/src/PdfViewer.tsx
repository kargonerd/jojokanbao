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
      const next = new Set(prev);
      next.add(pageNum);
      return next;
    });
  }, []);

  const removeFailedPage = useCallback((pageNum: number) => {
    setFailedPages((prev) => {
      const next = new Set(prev);
      next.delete(pageNum);
      return next;
    });
  }, []);

  // Preload adjacent pages (forward AND backward, matching original)
  const preloadAdjacent = useCallback((pageNum: number) => {
    addPage(pageNum - 2);
    addPage(pageNum - 1);
    addPage(pageNum + 1);
    addPage(pageNum + 2);
  }, [addPage]);

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
    preloadAdjacent(pageNum);
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

  const sortedPages = Array.from(renderedPages).sort((a, b) => a - b);
  const sortedFailed = Array.from(failedPages).sort((a, b) => a - b);

  // Build page items with spacers (matching original pageItems logic)
  const allVisible = [...sortedPages, ...sortedFailed];
  const pageNums = Array.from(new Set(allVisible)).sort((a, b) => a - b);

  // Build items array with spacers
  const items: Array<{ type: "spacer" | "page" | "failed"; pageNum?: number; key: string; height?: number }> = [];
  const PAGE_HEIGHT = 800;
  const PAGE_GAP = 24;

  let prev = 0;
  for (const pageNum of pageNums) {
    const skipped = pageNum - prev - 1;
    if (skipped > 0) {
      items.push({ type: "spacer", key: `spacer-${prev + 1}-${pageNum - 1}`, height: skipped * (PAGE_HEIGHT + PAGE_GAP) });
    }
    if (failedPages.has(pageNum)) {
      items.push({ type: "failed", pageNum, key: `failed-${pageNum}` });
    } else {
      items.push({ type: "page", pageNum, key: `page-${pageNum}` });
    }
    prev = pageNum;
  }

  // Trailing spacer
  const trailing = document.numPages - prev;
  if (trailing > 0) {
    items.push({ type: "spacer", key: `spacer-${prev + 1}-${document.numPages}`, height: trailing * (PAGE_HEIGHT + PAGE_GAP) });
  }

  return (
    <div ref={containerRef} className={`w-full ${className}`}>
      {items.map((item) => {
        if (item.type === "spacer") {
          return <div key={item.key} className="w-full" style={{ height: item.height }} />;
        }

        if (item.type === "failed" && item.pageNum) {
          return (
            <div key={item.key} className="mb-6 flex items-center justify-center" style={{ height: PAGE_HEIGHT }}>
              <div className="text-center">
                <p className="text-lg text-ink mb-2">第 {item.pageNum} 页加载失败</p>
                <p className="text-sm text-muted mb-4">网络或渲染异常，可以单独重试本页</p>
                <button className="btn btn-outline text-sm cursor-pointer" onClick={() => handleRetryPage(item.pageNum!)}>重试本页</button>
              </div>
            </div>
          );
        }

        if (item.type === "page" && item.pageNum) {
          return (
            <div key={item.key} className="mb-6">
              <div className="relative">
                <PdfPage
                  id={`page-${item.pageNum}`}
                  document={document}
                  pageNumber={item.pageNum}
                  scale={scale}
                  onRendered={() => handlePageRendered(item.pageNum!)}
                  onError={() => handlePageError(item.pageNum!)}
                />
              </div>
            </div>
          );
        }

        return null;
      })}

      {/* Unrendered page placeholders */}
      {Array.from({ length: document.numPages }, (_, i) => i + 1)
        .filter((p) => !renderedPages.has(p) && !failedPages.has(p))
        .map((pageNum) => (
          <div
            key={`placeholder-${pageNum}`}
            data-page={pageNum}
            data-page-placeholder
            className="mb-6 flex items-center justify-center border border-rule"
            style={{ height: PAGE_HEIGHT }}
            id={`page-empty-${pageNum}`}
          >
            <div className="text-center">
              <p className="text-lg text-ink mb-2">第 {pageNum} 页</p>
              <p className="text-sm text-muted mb-4">滚动到此处时加载</p>
              <button className="btn btn-outline text-sm cursor-pointer" onClick={() => handleManualPageLoad(pageNum)}>加载本页</button>
            </div>
          </div>
        ))}
    </div>
  );
}
