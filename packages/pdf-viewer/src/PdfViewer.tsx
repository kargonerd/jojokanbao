import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { PdfPage } from "./PdfPage";

interface PdfViewerProps {
  document: PDFDocumentProxy;
  initialPage?: number;
  scale?: number;
  quality?: number;
  zoomEnabled?: boolean;
  zoom?: number;
  onZoomChange?: (zoom: number) => void;
  onZoomEnabledChange?: (enabled: boolean) => void;
  className?: string;
  scrollContainerRef?: RefObject<HTMLElement | null>;
  onPageChange?: (page: number) => void;
  onPageRendered?: (page: number) => void;
  enableTextLayer?: boolean;
}

interface VisiblePage {
  top: number;
  bottom: number;
}

const DEFAULT_PAGE_ASPECT_RATIO = 210 / 297;
const PAGE_PRELOAD_MARGIN = "25% 0px";
const PAGE_GAP_CLASS = "mb-6";
const MIN_ZOOM = 1;
const MAX_ZOOM = 3;
const CLICK_ZOOM_STEP = 0.5;
const WHEEL_ZOOM_STEP = 0.25;

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  scrollLeft: number;
  scrollTop: number;
  moved: boolean;
}

interface PointerPosition {
  clientX: number;
  clientY: number;
}

interface PinchState {
  pointerIds: [number, number];
  startDistance: number;
  startZoom: number;
}

function clampPage(page: number, numPages: number): number {
  if (!Number.isFinite(page)) return 1;
  return Math.min(Math.max(Math.trunc(page), 1), Math.max(numPages, 1));
}

function clampZoom(zoom: number): number {
  return Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM);
}

export function PdfViewer({
  document,
  initialPage = 1,
  scale,
  quality,
  zoomEnabled = false,
  zoom = 1,
  onZoomChange,
  onZoomEnabledChange,
  className = "",
  scrollContainerRef,
  onPageChange,
  onPageRendered,
  enableTextLayer = true,
}: PdfViewerProps) {
  const normalizedInitialPage = clampPage(initialPage, document.numPages);
  const [loadedPages, setLoadedPages] = useState<Set<number>>(() => new Set([normalizedInitialPage]));
  const [failedPages, setFailedPages] = useState<Set<number>>(new Set());
  const [pageAspectRatios, setPageAspectRatios] = useState<Map<number, number>>(new Map());
  const [defaultPageAspectRatio, setDefaultPageAspectRatio] = useState(DEFAULT_PAGE_ASPECT_RATIO);
  const containerRef = useRef<HTMLDivElement>(null);
  const zoomContentRef = useRef<HTMLDivElement>(null);
  const currentPageRef = useRef(normalizedInitialPage);
  const pagesInLoadRangeRef = useRef<Set<number>>(new Set([normalizedInitialPage]));
  const previousZoomRef = useRef(1);
  const zoomAnchorRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const activeTouchPointersRef = useRef<Map<number, PointerPosition>>(new Map());
  const pinchRef = useRef<PinchState | null>(null);
  const effectiveZoom = zoomEnabled ? clampZoom(zoom) : 1;

  useLayoutEffect(() => {
    const previousZoom = previousZoomRef.current;
    if (previousZoom === effectiveZoom) return;

    const scrollContainer = scrollContainerRef?.current;
    const container = containerRef.current;
    if (scrollContainer && container) {
      const rootRect = scrollContainer.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const anchor = zoomAnchorRef.current;
      const focusX = anchor ? anchor.clientX - rootRect.left : scrollContainer.clientWidth / 2;
      const focusY = anchor ? anchor.clientY - rootRect.top : scrollContainer.clientHeight / 2;
      const containerLeft = scrollContainer.scrollLeft + containerRect.left - rootRect.left;
      const containerTop = scrollContainer.scrollTop + containerRect.top - rootRect.top;
      const localX = (scrollContainer.scrollLeft + focusX - containerLeft) / previousZoom;
      const localY = (scrollContainer.scrollTop + focusY - containerTop) / previousZoom;
      const ratio = effectiveZoom / previousZoom;

      scrollContainer.scrollLeft = effectiveZoom === 1
        ? 0
        : containerLeft + localX * effectiveZoom - focusX;
      scrollContainer.scrollTop = containerTop + localY * effectiveZoom - focusY;
      if (!Number.isFinite(ratio)) scrollContainer.scrollLeft = 0;
    }

    previousZoomRef.current = effectiveZoom;
    zoomAnchorRef.current = null;
  }, [effectiveZoom, scrollContainerRef]);

  const addPage = useCallback((pageNumber: number) => {
    if (pageNumber < 1 || pageNumber > document.numPages) return;
    setLoadedPages((previous) => {
      if (previous.has(pageNumber)) return previous;
      const next = new Set(previous);
      next.add(pageNumber);
      return next;
    });
  }, [document.numPages]);

  useEffect(() => {
    const pageNumber = clampPage(initialPage, document.numPages);
    setLoadedPages(new Set([pageNumber]));
    setFailedPages(new Set());
    setPageAspectRatios(new Map());
    setDefaultPageAspectRatio(DEFAULT_PAGE_ASPECT_RATIO);
    currentPageRef.current = pageNumber;
    pagesInLoadRangeRef.current = new Set([pageNumber]);
  }, [document, document.numPages, initialPage]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const pagesInRange = pagesInLoadRangeRef.current;
        for (const entry of entries) {
          const pageNumber = Number(entry.target.getAttribute("data-page"));
          if (!pageNumber) continue;
          if (entry.isIntersecting) pagesInRange.add(pageNumber);
          else pagesInRange.delete(pageNumber);
        }
        setLoadedPages(() => new Set([...pagesInRange, currentPageRef.current]));
      },
      {
        root: scrollContainerRef?.current ?? null,
        rootMargin: PAGE_PRELOAD_MARGIN,
      },
    );

    container.querySelectorAll("[data-pdf-page]").forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [addPage, document, scrollContainerRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !onPageChange) return;

    const visiblePages = new Map<number, VisiblePage>();
    const root = scrollContainerRef?.current ?? null;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageNumber = Number(entry.target.getAttribute("data-page"));
          if (!pageNumber) continue;
          if (entry.isIntersecting) {
            visiblePages.set(pageNumber, {
              top: entry.boundingClientRect.top,
              bottom: entry.boundingClientRect.bottom,
            });
          } else {
            visiblePages.delete(pageNumber);
          }
        }

        if (visiblePages.size === 0) return;
        const atDocumentEnd = root
          ? Math.ceil(root.scrollTop + root.clientHeight) >= root.scrollHeight - 1
          : Math.ceil(window.scrollY + window.innerHeight) >= window.document.documentElement.scrollHeight - 1;
        const lastPageIsVisible = visiblePages.has(document.numPages);
        const rootTop = root?.getBoundingClientRect().top ?? 0;
        const focusLine = rootTop + 72;
        const pageNumber = atDocumentEnd && lastPageIsVisible
          ? document.numPages
          : [...visiblePages.entries()].sort(([, a], [, b]) => {
              const aContainsFocus = a.top <= focusLine && a.bottom > focusLine;
              const bContainsFocus = b.top <= focusLine && b.bottom > focusLine;
              if (aContainsFocus !== bContainsFocus) return aContainsFocus ? -1 : 1;
              return Math.abs(a.top - focusLine) - Math.abs(b.top - focusLine);
            })[0]![0];

        if (pageNumber !== currentPageRef.current) {
          const previousPage = currentPageRef.current;
          currentPageRef.current = pageNumber;
          setLoadedPages((previous) => {
            const next = new Set(previous).add(pageNumber);
            if (!pagesInLoadRangeRef.current.has(previousPage)) next.delete(previousPage);
            return next;
          });
          onPageChange(pageNumber);
        }
      },
      {
        root,
        threshold: [0, 0.25, 0.5, 0.75, 1],
      },
    );

    container.querySelectorAll("[data-pdf-page]").forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [document, onPageChange, scrollContainerRef]);

  const handlePageError = (pageNumber: number) => {
    setLoadedPages((previous) => {
      const next = new Set(previous);
      next.delete(pageNumber);
      return next;
    });
    setFailedPages((previous) => new Set(previous).add(pageNumber));
  };

  const handleRetryPage = (pageNumber: number) => {
    setFailedPages((previous) => {
      const next = new Set(previous);
      next.delete(pageNumber);
      return next;
    });
    addPage(pageNumber);
  };

  const handlePageMetrics = useCallback((pageNumber: number, { width, height }: { width: number; height: number }) => {
    if (!(width > 0) || !(height > 0)) return;
    const aspectRatio = width / height;
    setPageAspectRatios((previous) => {
      if (previous.get(pageNumber) === aspectRatio) return previous;
      const next = new Map(previous);
      next.set(pageNumber, aspectRatio);
      return next;
    });
    if (pageNumber === normalizedInitialPage) setDefaultPageAspectRatio(aspectRatio);
  }, [normalizedInitialPage]);

  const pages = Array.from({ length: document.numPages }, (_, index) => index + 1);

  const capturePointer = (element: HTMLDivElement, pointerId: number) => {
    if (typeof element.setPointerCapture === "function") element.setPointerCapture(pointerId);
  };

  const releasePointer = (element: HTMLDivElement, pointerId: number) => {
    if (typeof element.hasPointerCapture === "function" && element.hasPointerCapture(pointerId)) {
      element.releasePointerCapture(pointerId);
    }
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if ((event.target as Element).closest("button")) return;
    const scrollContainer = scrollContainerRef?.current;
    if (!scrollContainer) return;

    if (event.pointerType === "touch") {
      const activePointers = activeTouchPointersRef.current;
      activePointers.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });

      if (activePointers.size >= 2 && onZoomChange) {
        const pointerEntries = [...activePointers.entries()];
        const firstEntry = pointerEntries[0];
        const secondEntry = pointerEntries[1];
        if (!firstEntry || !secondEntry) return;
        const [firstPointerId, first] = firstEntry;
        const [secondPointerId, second] = secondEntry;
        const startDistance = Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
        if (startDistance > 0) {
          event.preventDefault();
          capturePointer(event.currentTarget, firstPointerId);
          capturePointer(event.currentTarget, secondPointerId);
          dragRef.current = null;
          pinchRef.current = {
            pointerIds: [firstPointerId, secondPointerId],
            startDistance,
            startZoom: effectiveZoom,
          };
          if (!zoomEnabled) {
            onZoomChange(effectiveZoom);
            onZoomEnabledChange?.(true);
          }
          return;
        }
      }

      // Preserve native one-finger vertical scrolling until a pinch starts.
      if (!zoomEnabled) return;
    } else if (!zoomEnabled) {
      return;
    }

    event.preventDefault();
    capturePointer(event.currentTarget, event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: scrollContainer.scrollLeft,
      scrollTop: scrollContainer.scrollTop,
      moved: false,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") {
      const activePointers = activeTouchPointersRef.current;
      if (activePointers.has(event.pointerId)) {
        activePointers.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
      }

      const pinch = pinchRef.current;
      if (pinch?.pointerIds.includes(event.pointerId) && onZoomChange) {
        const first = activePointers.get(pinch.pointerIds[0]);
        const second = activePointers.get(pinch.pointerIds[1]);
        if (!first || !second) return;

        const distance = Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
        zoomAnchorRef.current = {
          clientX: (first.clientX + second.clientX) / 2,
          clientY: (first.clientY + second.clientY) / 2,
        };
        onZoomChange(clampZoom(pinch.startZoom * (distance / pinch.startDistance)));
        event.preventDefault();
        return;
      }
    }

    const drag = dragRef.current;
    const scrollContainer = scrollContainerRef?.current;
    if (!drag || drag.pointerId !== event.pointerId || !scrollContainer) return;

    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (Math.abs(deltaX) > 4 || Math.abs(deltaY) > 4) drag.moved = true;
    scrollContainer.scrollLeft = drag.scrollLeft - deltaX;
    scrollContainer.scrollTop = drag.scrollTop - deltaY;
    event.preventDefault();
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") {
      const activePointers = activeTouchPointersRef.current;
      activePointers.delete(event.pointerId);
      const pinch = pinchRef.current;
      if (pinch?.pointerIds.includes(event.pointerId)) {
        pinchRef.current = null;
        dragRef.current = null;
        releasePointer(event.currentTarget, event.pointerId);

        if (effectiveZoom <= MIN_ZOOM && onZoomEnabledChange) {
          for (const pointerId of activePointers.keys()) releasePointer(event.currentTarget, pointerId);
          activePointers.clear();
          onZoomEnabledChange(false);
          return;
        }

        const remainingPointer = activePointers.entries().next().value as [number, PointerPosition] | undefined;
        const scrollContainer = scrollContainerRef?.current;
        if (remainingPointer && scrollContainer) {
          const [pointerId, position] = remainingPointer;
          dragRef.current = {
            pointerId,
            startX: position.clientX,
            startY: position.clientY,
            scrollLeft: scrollContainer.scrollLeft,
            scrollTop: scrollContainer.scrollTop,
            moved: true,
          };
        }
        return;
      }
    }

    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    if (!drag.moved && event.pointerType !== "touch" && event.type === "pointerup" && onZoomChange) {
      zoomAnchorRef.current = { clientX: event.clientX, clientY: event.clientY };
      onZoomChange(clampZoom(effectiveZoom + (event.shiftKey ? -CLICK_ZOOM_STEP : CLICK_ZOOM_STEP)));
    }
    dragRef.current = null;
    releasePointer(event.currentTarget, event.pointerId);
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!zoomEnabled || !(event.ctrlKey || event.metaKey) || !onZoomChange) return;
    event.preventDefault();
    zoomAnchorRef.current = { clientX: event.clientX, clientY: event.clientY };
    onZoomChange(clampZoom(effectiveZoom + (event.deltaY < 0 ? WHEEL_ZOOM_STEP : -WHEEL_ZOOM_STEP)));
  };

  return (
    <div ref={containerRef} data-pdf-viewer data-zoom={effectiveZoom} className={`relative w-full ${className}`}>
      <div
        ref={zoomContentRef}
        data-pdf-zoom-content
        className={zoomEnabled ? "cursor-grab active:cursor-grabbing" : ""}
        style={{
          width: `${effectiveZoom * 100}%`,
          touchAction: zoomEnabled ? "none" : "pan-y",
          userSelect: zoomEnabled ? "none" : undefined,
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onWheel={handleWheel}
        onDragStart={(event) => event.preventDefault()}
      >
        {pages.map((pageNumber) => {
        const failed = failedPages.has(pageNumber);
        const loaded = loadedPages.has(pageNumber);
        const aspectRatio = pageAspectRatios.get(pageNumber) ?? defaultPageAspectRatio;

        return (
          <section
            key={pageNumber}
            id={`page-${pageNumber}`}
            data-page={pageNumber}
            data-pdf-page
            data-page-state={failed ? "failed" : loaded ? "loaded" : "placeholder"}
            className={`relative ${PAGE_GAP_CLASS}`}
            style={{ aspectRatio: String(aspectRatio) }}
            aria-label={`第 ${pageNumber} 页`}
          >
            {failed ? (
              <div className="absolute inset-0 flex items-center justify-center border border-rule bg-paper">
                <div className="text-center">
                  <p className="text-lg text-ink mb-2">第 {pageNumber} 页加载失败</p>
                  <p className="text-sm text-muted mb-4">网络或渲染异常，可以单独重试本页</p>
                  <button className="btn btn-outline text-sm cursor-pointer" onClick={() => handleRetryPage(pageNumber)}>
                    重试本页
                  </button>
                </div>
              </div>
            ) : loaded ? (
              <PdfPage
                document={document}
                pageNumber={pageNumber}
                scale={scale}
                quality={quality}
                renderZoom={onZoomChange ? MAX_ZOOM : 1}
                layoutZoom={effectiveZoom}
                enableTextLayer={enableTextLayer}
                onPageMetrics={handlePageMetrics}
                onRendered={onPageRendered}
                onError={() => handlePageError(pageNumber)}
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center border border-rule bg-paper">
                <div className="text-center">
                  <p className="text-lg text-ink mb-2">第 {pageNumber} 页</p>
                  <p className="text-sm text-muted mb-4">滚动到此处时按需加载</p>
                  <button className="btn btn-outline text-sm cursor-pointer" onClick={() => addPage(pageNumber)}>
                    加载本页
                  </button>
                </div>
              </div>
            )}
          </section>
        );
        })}
      </div>
    </div>
  );
}
