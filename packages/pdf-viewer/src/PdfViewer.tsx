import { useState, useRef, useEffect, useCallback } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist/types/display/api";
import { PdfPage } from "./PdfPage";

interface PdfViewerProps {
  document: PDFDocumentProxy;
  initialPage?: number;
  targetPage?: number;
  scale?: number;
  className?: string;
  onPageChange?: (page: number) => void;
}

export function PdfViewer({ document, initialPage = 1, targetPage, scale = 2, className = "", onPageChange }: PdfViewerProps) {
  const [renderedPages, setRenderedPages] = useState<Set<number>>(new Set([initialPage]));
  const [failedPages, setFailedPages] = useState<Set<number>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const pendingScrollPage = useRef<number | null>(initialPage > 1 ? initialPage : null);

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
    pendingScrollPage.current = initialPage > 1 ? initialPage : null;
  }, [document, initialPage]);

  useEffect(() => {
    if (!targetPage || targetPage < 1 || targetPage > document.numPages) return;
    pendingScrollPage.current = targetPage;
    addPage(targetPage);
  }, [targetPage, document.numPages, addPage]);

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
    if (pendingScrollPage.current === pageNum) {
      globalThis.document.querySelector(`#page-${pageNum}`)?.scrollIntoView();
      pendingScrollPage.current = null;
    }
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
  const PAGE_GAP = 24;
  const visiblePages = new Set<number>();
  const addVisiblePage = (pageNum: number) => {
    if (pageNum >= 1 && pageNum <= document.numPages) visiblePages.add(pageNum);
  };

  [...renderedPages, ...failedPages].forEach((pageNum) => {
    addVisiblePage(pageNum);
    addVisiblePage(pageNum - 2);
    addVisiblePage(pageNum - 1);
    addVisiblePage(pageNum + 1);
    addVisiblePage(pageNum + 2);
  });

  if (visiblePages.size === 0) addVisiblePage(initialPage);

  const pageNums = Array.from(visiblePages).sort((a, b) => a - b);
  const items: Array<
    | { type: "spacer"; key: string; height: number }
    | { type: "failed"; pageNum: number; key: string }
    | { type: "page"; pageNum: number; key: string }
    | { type: "placeholder"; pageNum: number; key: string }
  > = [];
  let previousPage = 0;

  pageNums.forEach((pageNum) => {
    const skippedPages = pageNum - previousPage - 1;
    if (skippedPages > 0) {
      items.push({
        type: "spacer",
        key: `spacer-${previousPage + 1}-${pageNum - 1}`,
        height: skippedPages * (PAGE_HEIGHT + PAGE_GAP),
      });
    }

    if (failedPages.has(pageNum)) items.push({ type: "failed", pageNum, key: `failed-${pageNum}` });
    else if (renderedPages.has(pageNum)) items.push({ type: "page", pageNum, key: `page-${pageNum}` });
    else items.push({ type: "placeholder", pageNum, key: `placeholder-${pageNum}` });

    previousPage = pageNum;
  });

  const trailingPages = document.numPages - previousPage;
  if (trailingPages > 0) {
    items.push({
      type: "spacer",
      key: `spacer-${previousPage + 1}-${document.numPages}`,
      height: trailingPages * (PAGE_HEIGHT + PAGE_GAP),
    });
  }

  return (
    <div ref={containerRef} className={`w-full ${className}`}>
      {items.map((item) => {
        if (item.type === "spacer") {
          return <div key={item.key} aria-hidden="true" style={{ height: item.height }} />;
        }

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
                  placeholderHeight={PAGE_HEIGHT}
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
