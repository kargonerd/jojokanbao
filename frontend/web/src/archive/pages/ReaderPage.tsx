import { useParams, useNavigate } from "react-router-dom";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { fetchPdfDownloadBytes, PdfViewer, usePdfDocument } from "@jojo/pdf-viewer";
import { archivePdfUrl, formatArchiveIssueLabel } from "@jojo/content";
import { EmptyState, DatePicker, Toolbar, YearPicker } from "@jojo/ui";
import { PUBLICATIONS, type PublicationName } from "../publications";
import { archiveIssuePath } from "../../routes";
import { useRecentReadingStore } from "../../library/recentReadingStore";
import { ReadingLoadingState } from "../../reading/ReadingLoadingState";

const PAGE_SCROLL_GAP = 16;
const READER_TOOLBAR_MAX_HEIGHT = 61;
const DEFAULT_ZOOM = 1.5;

function isCalendarDate(value: string): boolean {
  if (!/^\d{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const parsed = new Date(year, month - 1, day);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day;
}

function DownloadIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M8 2v8m0 0 3-3m-3 3L5 7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 13h10" strokeLinecap="round" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M8 2.5v8" strokeLinecap="round" />
      <path d="M4.8 5.7 8 2.5l3.2 3.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.5 8.5v4.2c0 .5.4.8.8.8h7.4c.5 0 .8-.4.8-.8V8.5" strokeLinecap="round" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
    </svg>
  );
}

function MagnifierIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="6.75" cy="6.75" r="4.25" />
      <path d="m10 10 3.5 3.5M6.75 4.75v4M4.75 6.75h4" strokeLinecap="round" />
    </svg>
  );
}

function OutlineIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M5.5 3h8M5.5 8h8M5.5 13h8" strokeLinecap="round" />
      <circle cx="2.5" cy="3" r=".75" fill="currentColor" stroke="none" />
      <circle cx="2.5" cy="8" r=".75" fill="currentColor" stroke="none" />
      <circle cx="2.5" cy="13" r=".75" fill="currentColor" stroke="none" />
    </svg>
  );
}

interface PdfOutlineItem {
  title: string;
  dest: string | unknown[] | null;
  items: PdfOutlineItem[];
}

const PAGE_OUTLINE_TITLE = /^第\s*([〇零一二三四五六七八九十百\d０-９]+)\s*版(?:([（(:：\s].*))?$/u;
const CHINESE_DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

function toChinesePageNumber(value: string): string {
  const asciiValue = value.replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - 0xfee0));
  if (!/^\d+$/.test(asciiValue)) return value;

  const pageNumber = Number(asciiValue);
  if (pageNumber < 10) return CHINESE_DIGITS[pageNumber] ?? asciiValue;
  if (pageNumber < 20) return `十${pageNumber === 10 ? "" : CHINESE_DIGITS[pageNumber % 10]}`;
  if (pageNumber < 100) {
    const ones = pageNumber % 10;
    return `${CHINESE_DIGITS[Math.floor(pageNumber / 10)]}十${ones === 0 ? "" : CHINESE_DIGITS[ones]}`;
  }
  return asciiValue;
}

function normalizePageOutlineTitle(title: string): string | null {
  const match = PAGE_OUTLINE_TITLE.exec(title.trim());
  if (!match?.[1]) return null;

  const pageNumber = toChinesePageNumber(match[1]);
  let section = (match[2] ?? "").trim();
  if ((section.startsWith("（") && section.endsWith("）"))
    || (section.startsWith("(") && section.endsWith(")"))) {
    section = section.slice(1, -1).trim();
  } else {
    section = section.replace(/^[:：]\s*/, "").trim();
  }

  return `第${pageNumber}版${section ? `（${section}）` : ""}`;
}

function navigableOutlineItems(items: PdfOutlineItem[]): PdfOutlineItem[] {
  const result: PdfOutlineItem[] = [];
  for (const item of items) {
    const title = (item.title ?? "").trim();
    const children = navigableOutlineItems(item.items ?? []);
    if (title && (item.dest !== null || children.length > 0)) {
      result.push({ ...item, title, items: children });
    } else {
      result.push(...children);
    }
  }
  return result;
}

function pageOutlineItems(items: PdfOutlineItem[]): PdfOutlineItem[] {
  const result: PdfOutlineItem[] = [];
  for (const item of items) {
    const title = normalizePageOutlineTitle(item.title ?? "");
    const children = navigableOutlineItems(item.items ?? []);
    if (title) {
      if (item.dest !== null || children.length > 0) {
        result.push({ ...item, title, items: children });
      }
      continue;
    }
    result.push(...pageOutlineItems(item.items ?? []));
  }
  return result;
}

function OutlineItem({
  item,
  depth,
  defaultOpen,
  onSelect,
}: {
  item: PdfOutlineItem;
  depth: number;
  defaultOpen?: boolean;
  onSelect: (item: PdfOutlineItem) => void;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const hasChildren = item.items.length > 0;
  const isEdition = depth === 0;

  return (
    <div>
      <div
        className={`flex min-h-9 items-stretch border-b border-rule ${isEdition ? "bg-red/5" : "bg-paper"}`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            className="w-7 shrink-0 border-0 bg-transparent text-xs text-muted hover:text-red"
            aria-label={`${open ? "收起" : "展开"}${item.title}`}
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? "▾" : "▸"}
          </button>
        ) : (
          <span className="w-7 shrink-0" aria-hidden="true" />
        )}
        {item.dest !== null ? (
          <button
            type="button"
            className={`min-w-0 flex-1 border-0 bg-transparent py-2 pr-3 text-left text-xs leading-5 transition-colors hover:text-red ${isEdition ? "font-bold text-red" : "text-ink"}`}
            onClick={() => onSelect(item)}
          >
            {item.title}
          </button>
        ) : (
          <span className={`min-w-0 flex-1 py-2 pr-3 text-xs leading-5 ${isEdition ? "font-bold text-red" : "text-muted"}`}>
            {item.title}
          </span>
        )}
      </div>
      {hasChildren && open
        ? item.items.map((child, index) => (
            <OutlineItem
              key={`${depth + 1}-${index}-${child.title}`}
              item={child}
              depth={depth + 1}
              onSelect={onSelect}
            />
          ))
        : null}
    </div>
  );
}

function OutlineItems({ items, onSelect }: { items: PdfOutlineItem[]; onSelect: (item: PdfOutlineItem) => void }) {
  return items.map((item, index) => (
    <OutlineItem
      key={`${index}-${item.title}`}
      item={item}
      depth={0}
      defaultOpen={index === 0}
      onSelect={onSelect}
    />
  ));
}

interface ReaderPageProps {
  type: "newspaper" | "magazine";
  name: PublicationName;
}

export function ReaderPage({ type, name }: ReaderPageProps) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const config = PUBLICATIONS[name];

  // Route params are the source of truth. Deriving these synchronously avoids
  // issuing a PDF request with stale state while switching publications.
  const rawId = id || "";
  const hasExpectedShape = type === "magazine" ? /^\d{6}$/.test(rawId) : /^\d{8}$/.test(rawId);
  const candidateYear = rawId.slice(0, 4);
  const candidateSeq = Number(rawId.slice(4, 6));
  const routeError = !hasExpectedShape
    ? "链接中的日期或期数格式不正确。"
    : type === "newspaper" && !isCalendarDate(rawId)
      ? "链接中的日期不是有效日期。"
      : type === "magazine" && !config.seqConfig?.[candidateYear]?.includes(candidateSeq)
        ? "该年份没有对应的杂志期数。"
        : null;
  const routeId = routeError ? "" : rawId;
  const date = type === "magazine" ? routeId.slice(0, 4) : routeId;
  const seq = type === "magazine" ? Number(routeId.slice(4, 6)) || 1 : 1;

  // ─── State ───
  const [resolutionRate, setResolutionRate] = useState(3);
  const [zoomEnabled, setZoomEnabled] = useState(false);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [outlineItems, setOutlineItems] = useState<PdfOutlineItem[]>([]);
  const [renderedInitialPageKey, setRenderedInitialPageKey] = useState("");
  const [seqDropdownOpen, setSeqDropdownOpen] = useState(false);
  const [jumpToPageNum, setJumpToPageNum] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [showBackTop, setShowBackTop] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  const rememberRecentReading = useRecentReadingStore((state) => state.remember);
  const containerRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const seqDropdownRef = useRef<HTMLDivElement>(null);
  const seqDropdownPanelRef = useRef<HTMLDivElement>(null);
  const seqListboxRef = useRef<HTMLDivElement>(null);
  const shareResetTimer = useRef<number | null>(null);
  const alignedInitialPageRef = useRef<string | null>(null);

  const pdfUrl = routeId ? archivePdfUrl(name, routeId) : "";
  const { document: pdfDoc, loading, error, numPages } = usePdfDocument({ url: pdfUrl, protectedPdf: "auto" });
  const downloadFilename = `${name}-${routeId}.pdf`;

  useEffect(() => {
    if (!routeId) return;
    const issueHref = archiveIssuePath(name, routeId);
    const href = currentPage > 1 ? `${issueHref}#page-${currentPage}` : issueHref;
    const progress = numPages > 1 ? ((currentPage - 1) / (numPages - 1)) * 100 : 0;
    rememberRecentReading({
      id: `periodical:${name}`,
      kind: "periodical",
      publicationId: name,
      title: config.label,
      subtitle: formatArchiveIssueLabel(routeId),
      href,
      progress,
    });
  }, [config.label, currentPage, name, numPages, rememberRecentReading, routeId]);

  // ─── Hash navigation ───
  const getHashPageNum = useCallback((): number => {
    const m = /^#page-(\d+)$/i.exec(window.location.hash);
    return m?.[1] ? parseInt(m[1], 10) : 0;
  }, []);

  const goToPage = useCallback((pageNum: number, pageOffsetRatio = 0) => {
    const scrollContainer = containerRef.current;
    const page = document.querySelector<HTMLElement>(`#page-${pageNum}`);
    if (!scrollContainer || !page) return;

    const toolbar = scrollContainer.querySelector<HTMLElement>("[data-reader-toolbar]");
    const containerTop = scrollContainer.getBoundingClientRect().top;
    const pageRect = page.getBoundingClientRect();
    const pageTop = pageRect.top;
    const toolbarHeight = toolbar?.getBoundingClientRect().height ?? 0;
    const normalizedOffset = Math.min(Math.max(pageOffsetRatio, 0), 1);
    const pageOffset = normalizedOffset > 0 ? (pageRect.height || 0) * normalizedOffset : 0;
    const top = scrollContainer.scrollTop + pageTop - containerTop + pageOffset - toolbarHeight - PAGE_SCROLL_GAP;
    scrollContainer.scrollTo({ top: Math.max(0, top) });
  }, []);

  useEffect(() => {
    setOutlineOpen(false);
    setOutlineItems([]);
    if (!pdfDoc || !config.pageOutlineAvailable?.(routeId)) return;

    let disposed = false;
    void pdfDoc.getOutline()
      .then((items) => {
        if (disposed) return;
        const nextItems = pageOutlineItems((items ?? []) as PdfOutlineItem[]);
        if (nextItems.length > 0) setOutlineItems(nextItems);
      })
      .catch(() => {});

    return () => {
      disposed = true;
    };
  }, [config, pdfDoc, routeId]);

  const replacePageHash = useCallback((pageNum: number) => {
    const nextHash = `#page-${pageNum}`;
    if (window.location.hash === nextHash) return;

    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}${nextHash}`,
    );
  }, []);

  useEffect(() => {
    const handler = () => {
      const pageNum = getHashPageNum();
      if (pageNum >= 1 && pageNum <= numPages) {
        setCurrentPage(pageNum);
        setJumpToPageNum(pageNum);
        goToPage(pageNum);
      }
    };
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, [getHashPageNum, goToPage, numPages]);

  // Determine initial page from hash (for PdfViewer to render first)
  const hashPage = useMemo(
    () => (typeof window !== "undefined" ? getHashPageNum() : 0),
    [getHashPageNum, routeId],
  );
  const initialPage = hashPage >= 1 && (numPages === 0 || hashPage <= numPages) ? hashPage : 1;
  const initialPageKey = pdfUrl ? `${pdfUrl}#${initialPage}` : "";
  const waitingForInitialPage = Boolean(pdfDoc && renderedInitialPageKey !== initialPageKey);
  const showInitialLoading = loading || waitingForInitialPage;
  const initialLoadingText = loading ? "正在加载 PDF 文档" : `正在加载第 ${initialPage} 页`;

  // Every page has a stable slot, so deep links can scroll before the canvas renders.
  useEffect(() => {
    if (!pdfDoc) return;
    alignedInitialPageRef.current = null;
    setCurrentPage(initialPage);
    setJumpToPageNum(initialPage);
    const frame = window.requestAnimationFrame(() => goToPage(initialPage));
    return () => window.cancelAnimationFrame(frame);
  }, [goToPage, initialPage, pdfDoc]);

  const handleInitialPageRendered = useCallback((pageNumber: number) => {
    const alignmentKey = `${pdfUrl}#${initialPage}`;
    if (pageNumber !== initialPage) return;

    setRenderedInitialPageKey(alignmentKey);
    if (alignedInitialPageRef.current === alignmentKey) return;

    alignedInitialPageRef.current = alignmentKey;
    window.requestAnimationFrame(() => goToPage(pageNumber));
  }, [goToPage, initialPage, pdfUrl]);

  const handleInitialPageError = useCallback((pageNumber: number) => {
    if (pageNumber === initialPage) setRenderedInitialPageKey(`${pdfUrl}#${initialPage}`);
  }, [initialPage, pdfUrl]);

  // ─── Navigation handlers ───
  const handleSeqChange = (newSeq: number) => {
    setSeqDropdownOpen(false);
    const seqStr = String(newSeq).padStart(2, '0');
    navigate(archiveIssuePath(name, `${date}${seqStr}`), { replace: true });
  };

  const handlePageJump = () => {
    if (jumpToPageNum >= 1 && jumpToPageNum <= numPages) {
      setCurrentPage(jumpToPageNum);
      goToPage(jumpToPageNum);
      replacePageHash(jumpToPageNum);
    }
  };

  const handleOutlineSelect = async (item: PdfOutlineItem) => {
    if (!pdfDoc || item.dest === null) return;

    try {
      const destination = typeof item.dest === "string"
        ? await pdfDoc.getDestination(item.dest)
        : item.dest;
      if (!destination?.length) return;

      const pageRef = destination[0];
      const pageIndex = Number.isInteger(pageRef)
        ? Number(pageRef)
        : await pdfDoc.getPageIndex(pageRef as Parameters<typeof pdfDoc.getPageIndex>[0]);
      const pageNumber = pageIndex + 1;
      if (pageNumber < 1 || pageNumber > numPages) return;

      let pageOffsetRatio = 0;
      const mode = (destination[1] as { name?: string } | undefined)?.name;
      const pdfTop = mode === "XYZ"
        ? destination[3]
        : mode === "FitH" || mode === "FitBH"
          ? destination[2]
          : mode === "FitR"
            ? destination[5]
            : null;
      if (typeof pdfTop === "number") {
        const page = await pdfDoc.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1 });
        const [, viewportTop] = viewport.convertToViewportPoint(0, pdfTop);
        pageOffsetRatio = viewportTop / Math.max(viewport.height, 1);
      }

      setOutlineOpen(false);
      setCurrentPage(pageNumber);
      setJumpToPageNum(pageNumber);
      goToPage(pageNumber, pageOffsetRatio);
      replacePageHash(pageNumber);
    } catch {
      // Malformed destinations are ignored without breaking the reader.
    }
  };

  const handleDownload = async () => {
    if (!pdfUrl || downloading) return;

    setDownloading(true);
    setDownloadProgress(0);
    try {
      const { bytes } = await fetchPdfDownloadBytes(pdfUrl, "auto", {
        onDownloadProgress: (loadedBytes, totalBytes) => {
          setDownloadProgress(Math.min(100, Math.round((loadedBytes / totalBytes) * 100)));
        },
      });
      const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "application/pdf" });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = downloadFilename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 250);
    } catch (downloadError) {
      window.alert(String(downloadError instanceof Error ? downloadError.message : downloadError));
    } finally {
      setDownloading(false);
      setDownloadProgress(null);
    }
  };

  const copyText = async (text: string) => {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  };

  const handleShare = async () => {
    try {
      const copied = await copyText(window.location.href);
      if (!copied) throw new Error("Copy failed");

      setShareCopied(true);
      if (shareResetTimer.current) window.clearTimeout(shareResetTimer.current);
      shareResetTimer.current = window.setTimeout(() => setShareCopied(false), 1600);
    } catch {
      window.alert("复制链接失败，请直接复制浏览器地址栏链接。");
    }
  };

  // ─── Scroll helpers ───
  const scrollToTop = () => containerRef.current?.scrollTo({ top: 0, behavior: "smooth" });

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (el) setShowBackTop(el.scrollTop > 400);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener("scroll", handleScroll);
    return () => el.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  useEffect(() => {
    return () => {
      if (shareResetTimer.current) window.clearTimeout(shareResetTimer.current);
    };
  }, []);

  useEffect(() => {
    setZoomEnabled(false);
  }, [pdfUrl]);

  useEffect(() => {
    if (!zoomEnabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setZoomEnabled(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [zoomEnabled]);

  useEffect(() => {
    if (!settingsOpen && !outlineOpen) return;

    const handleOutsideClick = (event: MouseEvent) => {
      if (!settingsRef.current?.contains(event.target as Node)) {
        setSettingsOpen(false);
        setOutlineOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setSettingsOpen(false);
      setOutlineOpen(false);
    };

    document.addEventListener("mousedown", handleOutsideClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [outlineOpen, settingsOpen]);

  useEffect(() => {
    if (!seqDropdownOpen) return;

    const handleOutsideClick = (event: MouseEvent) => {
      if (!seqDropdownRef.current?.contains(event.target as Node)) {
        setSeqDropdownOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSeqDropdownOpen(false);
    };

    document.addEventListener("mousedown", handleOutsideClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [seqDropdownOpen]);

  useEffect(() => {
    if (!seqDropdownOpen) return;

    window.requestAnimationFrame(() => {
      const listbox = seqListboxRef.current;
      const selectedOption = listbox?.querySelector<HTMLElement>(`[data-seq-option="${seq}"]`);
      if (!listbox || !selectedOption) return;

      const centeredTop = selectedOption.offsetTop - (listbox.clientHeight - selectedOption.clientHeight) / 2;
      const maxScrollTop = Math.max(0, listbox.scrollHeight - listbox.clientHeight);
      listbox.scrollTop = Math.min(maxScrollTop, Math.max(0, centeredTop));
    });
  }, [seqDropdownOpen, seq]);

  useEffect(() => {
    if (!seqDropdownOpen) return;
    const panel = seqDropdownPanelRef.current;
    const listbox = seqListboxRef.current;
    if (!panel || !listbox) return;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (!event.deltaY) return;

      const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? listbox.clientHeight : 1;
      const maxScrollTop = Math.max(0, listbox.scrollHeight - listbox.clientHeight);
      listbox.scrollTop = Math.min(maxScrollTop, Math.max(0, listbox.scrollTop + event.deltaY * multiplier));
    };

    panel.addEventListener("wheel", handleWheel, { passive: false });
    return () => panel.removeEventListener("wheel", handleWheel);
  }, [seqDropdownOpen]);

  // ─── Document title ───
  useEffect(() => {
    const titles: Record<string, string> = { rmrb: "人民日报", ckxx: "参考消息", hq: "红旗", rmhb: "人民画报", sjzs: "世界知识" };
    document.title = `${titles[name] || name} ${id} - JOJO看报`;
  }, [name, id]);

  // ─── Seq options for magazines ───
  const seqOptions = config?.seqConfig?.[date] || [];
  const selectedSeqText = config?.genSeqText?.(seq) || `第${seq}期`;

  const handleVisiblePageChange = useCallback((pageNumber: number) => {
    setCurrentPage(pageNumber);
    setJumpToPageNum(pageNumber);
    replacePageHash(pageNumber);
  }, [replacePageHash]);
  // TODO: Replace the mode toggle with visible “− / current zoom / +” controls
  // so users can discover and repeat zoom actions without relying on page clicks.
  const downloadStatus = downloading
    ? downloadProgress
      ? `${downloadProgress}%`
      : "下载中"
    : "下载";
  const downloadAriaLabel = downloading
    ? downloadProgress
      ? `下载中 ${downloadProgress}%`
      : "下载中"
    : "下载 PDF";
  const toolbarActions = pdfUrl ? (
    <div ref={settingsRef} className="relative ml-auto flex shrink-0 items-center justify-end gap-1 sm:gap-2">
      <button
        type="button"
        onClick={() => {
          if (zoomEnabled) {
            setZoomEnabled(false);
          } else {
            setZoom((currentZoom) => currentZoom <= 1 ? DEFAULT_ZOOM : currentZoom);
            setZoomEnabled(true);
          }
          setSettingsOpen(false);
          setOutlineOpen(false);
        }}
        className={`inline-flex h-8 items-center gap-1.5 border px-1.5 text-sm font-bold transition-colors sm:px-2.5 ${
          zoomEnabled
            ? "border-red bg-red text-paper"
            : "border-rule-dark bg-paper text-ink hover:border-red hover:text-red"
        }`}
        aria-label={zoomEnabled ? "关闭区域缩放" : "开启区域缩放"}
        aria-pressed={zoomEnabled}
        title={zoomEnabled ? "关闭区域缩放（Esc）" : "开启区域缩放"}
      >
        <MagnifierIcon />
        <span className="hidden sm:inline">放大</span>
      </button>
      {outlineItems.length > 0 ? (
        <button
          type="button"
          onClick={() => {
            setOutlineOpen((open) => !open);
            setSettingsOpen(false);
          }}
          className={`inline-flex h-8 items-center gap-1.5 border px-1.5 text-sm font-bold transition-colors sm:px-2.5 ${
            outlineOpen
              ? "border-red bg-red text-paper"
              : "border-rule-dark bg-paper text-ink hover:border-red hover:text-red"
          }`}
          aria-label="目录"
          aria-expanded={outlineOpen}
          aria-haspopup="dialog"
        >
          <OutlineIcon />
          <span className="hidden sm:inline">目录</span>
        </button>
      ) : null}
      <button
        type="button"
        onClick={handleDownload}
        disabled={downloading}
        className="inline-flex h-8 items-center gap-1.5 border border-rule-dark bg-paper px-1.5 text-sm font-bold text-red transition-colors hover:border-red hover:text-red-dark disabled:cursor-wait disabled:opacity-60 sm:px-2.5"
        aria-label={downloadAriaLabel}
      >
        <DownloadIcon />
        <span className="hidden sm:inline">{downloadStatus}</span>
      </button>
      <button
        type="button"
        onClick={handleShare}
        className="inline-flex h-8 items-center gap-1.5 border border-rule-dark bg-paper px-1.5 text-sm font-bold text-ink transition-colors hover:border-red hover:text-red sm:px-2.5"
        aria-label={shareCopied ? "已复制阅读链接" : "复制阅读链接"}
        title={shareCopied ? "已复制阅读链接" : "复制阅读链接"}
      >
        <ShareIcon />
        <span className="hidden sm:inline">{shareCopied ? "已复制" : "分享"}</span>
      </button>
      <button
        type="button"
        onClick={() => {
          setSettingsOpen(!settingsOpen);
          setOutlineOpen(false);
        }}
        className="inline-flex h-8 items-center gap-1.5 border border-rule-dark bg-paper px-1.5 text-sm font-bold text-ink transition-colors hover:border-red hover:text-red sm:px-2.5"
        aria-label="设置"
        aria-expanded={settingsOpen}
      >
        <SettingsIcon />
        <span className="hidden sm:inline">设置</span>
      </button>
      {outlineOpen ? (
        <div
          role="dialog"
          aria-label="PDF 目录"
          className="absolute right-0 top-10 z-[90] max-h-[min(65vh,560px)] w-[min(320px,calc(100vw-24px))] overflow-y-auto overscroll-y-contain border border-rule-dark bg-paper shadow-[4px_4px_0_rgba(139,26,26,.14)]"
        >
          <div className="sticky top-0 z-10 border-b border-rule-dark bg-paper px-3 py-2 text-xs font-bold tracking-wide text-red">
            PDF 目录
          </div>
          <OutlineItems items={outlineItems} onSelect={(item) => void handleOutlineSelect(item)} />
        </div>
      ) : null}
      {settingsOpen && (
        <div className="absolute right-0 top-10 z-[90] w-[min(220px,calc(100vw-24px))] border border-rule-dark bg-paper p-3 space-y-4 shadow-[4px_4px_0_rgba(139,26,26,.14)] sm:p-4">
          <div>
            <label className="block text-xs font-bold text-muted mb-2 tracking-wide">页面跳转</label>
            <div className="flex gap-2">
              <input type="number" value={jumpToPageNum} min={1} max={numPages || 1} className="h-8 w-16 text-sm text-center" onChange={(e) => setJumpToPageNum(Number(e.target.value))} />
              <button className="btn text-xs h-8" onClick={handlePageJump}>跳转</button>
            </div>
          </div>
          {config?.resolutionControl && (
            <div>
              <label className="block text-xs font-bold text-muted mb-2 tracking-wide">清晰度 ({resolutionRate})</label>
              <input type="range" min={1} max={3} value={resolutionRate} onChange={(e) => setResolutionRate(Number(e.target.value))} className="w-full accent-red" aria-label="清晰度" />
            </div>
          )}
          <div>
            <label className="block text-xs font-bold text-muted mb-2 tracking-wide">页面缩放 ({Math.round(zoom * 100)}%)</label>
            <input
              type="range"
              min={1}
              max={3}
              step={0.25}
              value={zoom}
              onChange={(event) => setZoom(Number(event.target.value))}
              className="w-full accent-red"
              aria-label="页面缩放"
            />
          </div>
        </div>
      )}
    </div>
  ) : null;

  return (
    <div
      ref={containerRef}
      data-reader-scroll-container
      className="h-full overflow-y-auto bg-paper"
      style={{ scrollPaddingTop: READER_TOOLBAR_MAX_HEIGHT + PAGE_SCROLL_GAP }}
    >
      {/* SEO hidden heading */}
      <h1 className="hidden">{config?.label || name} - {id}</h1>

      {/* Toolbar: Magazine mode */}
      {type === "magazine" ? (
        <Toolbar sticky data-reader-toolbar>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:flex-none sm:gap-2.5">
            <span className="hidden shrink-0 text-xs font-bold text-muted tracking-wide sm:inline sm:text-[13px]">日期</span>
            <YearPicker
              value={date}
              onChange={(y) => {
                const options = config?.seqConfig?.[y];
                if (!options?.length) return;
                const firstSeq = options[0];
                navigate(archiveIssuePath(name, `${y}${String(firstSeq).padStart(2, '0')}`), { replace: true });
              }}
              disabledYear={(year) => !config?.seqConfig?.[year]?.length}
              min={name === "sjzs" ? 1934 : name === "hq" ? 1958 : 1950}
              max={name === "hq" ? 1976 : name === "rmhb" ? 1976 : 2025}
              className="min-w-0 flex-1 sm:flex-none"
            />
          </div>
          <div ref={seqDropdownRef} className="relative flex min-w-0 shrink-0 items-center gap-1.5 sm:gap-2.5">
            <span className="hidden text-xs font-bold text-muted tracking-wide sm:inline sm:text-[13px]">期数</span>
            <button
              type="button"
              className="flex h-8 min-w-[92px] items-center justify-between gap-3 border border-rule-dark bg-paper px-2.5 text-left text-xs text-ink transition-colors hover:border-red hover:text-red sm:min-w-[120px] sm:text-sm"
              aria-haspopup="listbox"
              aria-expanded={seqDropdownOpen}
              onClick={() => setSeqDropdownOpen((open) => !open)}
            >
              <span className="truncate">{selectedSeqText}</span>
              <svg
                className={`h-3 w-3 shrink-0 transition-transform ${seqDropdownOpen ? "rotate-180" : ""}`}
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                aria-hidden="true"
              >
                <path d="m4 6 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {seqDropdownOpen && (
              <div ref={seqDropdownPanelRef} className="absolute left-0 top-full z-[90] mt-1 w-[160px] overscroll-y-contain border-2 border-red bg-paper shadow-[4px_4px_0_rgba(139,26,26,.14)] min-[390px]:left-auto min-[390px]:right-0">
                <div ref={seqListboxRef} className="max-h-64 overflow-y-auto overscroll-y-contain py-1" role="listbox" aria-label="期数">
                  {seqOptions.map((option) => {
                    const selected = option === seq;
                    const label = config?.genSeqText?.(option) || `第${option}期`;
                    return (
                      <button
                        key={option}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        data-seq-option={option}
                        className={`block h-9 w-full px-4 text-left text-sm transition-colors ${
                          selected ? "bg-red text-paper" : "text-ink hover:bg-red/10 hover:text-red"
                        }`}
                        onClick={() => handleSeqChange(option)}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          {numPages > 0 && (
            <span
              className="hidden shrink-0 whitespace-nowrap text-[11px] text-muted min-[360px]:inline sm:text-xs"
              data-reader-page-status
              aria-label={`第 ${currentPage} 页，共 ${numPages} 页`}
            >
              {currentPage} / {numPages}
            </span>
          )}
          {toolbarActions}
        </Toolbar>
      ) : (
        /* Toolbar: Newspaper mode */
        <Toolbar sticky data-reader-toolbar>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:flex-none sm:gap-2.5">
            <span className="hidden shrink-0 text-xs font-bold text-muted tracking-wide sm:inline sm:text-[13px]">日期</span>
            <DatePicker
              value={date}
              onChange={(ds) => navigate(archiveIssuePath(name, ds), { replace: true })}
              disabledDate={config?.disabledDate}
              unavailableLabel="暂无该期"
              className="min-w-0 flex-1 sm:flex-none"
            />
          </div>
          {numPages > 0 && (
            <span
              className="hidden shrink-0 whitespace-nowrap text-[11px] text-muted min-[360px]:inline sm:text-xs"
              data-reader-page-status
              aria-label={`第 ${currentPage} 页，共 ${numPages} 页`}
            >
              {currentPage} / {numPages}
            </span>
          )}
          {toolbarActions}
        </Toolbar>
      )}

      {/* Content */}
      <div className="px-4 py-4">
        {routeError && <EmptyState title="阅读链接无效" description={routeError} />}
        {showInitialLoading && <ReadingLoadingState kind="periodical" status={initialLoadingText} fullscreen />}
        {error && (
          <EmptyState title="没有当天文档或数据缺失" description={error} />
        )}
        {pdfDoc && (
          <PdfViewer
            document={pdfDoc}
            quality={resolutionRate}
            zoomEnabled={zoomEnabled}
            zoom={zoom}
            onZoomChange={setZoom}
            onZoomEnabledChange={setZoomEnabled}
            initialPage={initialPage}
            scrollContainerRef={containerRef}
            onPageChange={handleVisiblePageChange}
            onPageRendered={handleInitialPageRendered}
            onPageError={handleInitialPageError}
            enableTextLayer={config.enableTextLayer ?? true}
            suppressPageLoading={showInitialLoading}
          />
        )}
      </div>

      {/* Back to top */}
      {showBackTop && (
        <button
          className="fixed right-10 bottom-10 w-10 h-10 flex items-center justify-center border border-rule-dark bg-paper text-red hover:bg-red hover:text-cream transition-colors z-50 cursor-pointer"
          onClick={scrollToTop}
          aria-label="回到顶部"
        >
          <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 14V2m-5 5 5-5 5 5" /></svg>
        </button>
      )}
    </div>
  );
}
