import { useParams, useNavigate } from "react-router-dom";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { fetchPdfDownloadBytes, PdfViewer, usePdfDocument } from "@jojo/pdf-viewer";
import { EmptyState, LoadingSpinner, DatePicker, Toolbar, YearPicker } from "@jojo/ui";
import { PUBLICATIONS, type PublicationConfig } from "../publications";

const NEWSPAPER_HOST = "https://blacknews.jojokanbao.cn";

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

interface ReaderPageProps {
  type: "newspaper" | "magazine";
  name: string;
}

export function ReaderPage({ type, name }: ReaderPageProps) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const config: PublicationConfig = PUBLICATIONS[name] ?? PUBLICATIONS.rmrb!;

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
  const [zoom, setZoom] = useState(1.5);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [seqDropdownOpen, setSeqDropdownOpen] = useState(false);
  const [jumpToPageNum, setJumpToPageNum] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [showBackTop, setShowBackTop] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const seqDropdownRef = useRef<HTMLDivElement>(null);
  const seqDropdownPanelRef = useRef<HTMLDivElement>(null);
  const seqListboxRef = useRef<HTMLDivElement>(null);
  const shareResetTimer = useRef<number | null>(null);

  const pdfUrl = routeId
    ? `${NEWSPAPER_HOST}/${name.toUpperCase()}/${routeId.slice(0, 4)}/${routeId}.pdf`
    : "";
  const { document: pdfDoc, loading, error, numPages } = usePdfDocument({ url: pdfUrl, protectedPdf: "auto" });
  const downloadFilename = `${name}-${routeId}.pdf`;

  // ─── Hash navigation ───
  const getHashPageNum = useCallback((): number => {
    const m = /^#page-(\d+)$/i.exec(window.location.hash);
    return m?.[1] ? parseInt(m[1], 10) : 0;
  }, []);

  const goToPage = useCallback((pageNum: number) => {
    document.querySelector(`#page-${pageNum}`)?.scrollIntoView({ block: "start" });
  }, []);

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

  // Every page has a stable slot, so deep links can scroll before the canvas renders.
  useEffect(() => {
    if (!pdfDoc) return;
    setCurrentPage(initialPage);
    setJumpToPageNum(initialPage);
    const frame = window.requestAnimationFrame(() => goToPage(initialPage));
    return () => window.cancelAnimationFrame(frame);
  }, [goToPage, initialPage, pdfDoc]);

  // ─── Navigation handlers ───
  const handleSeqChange = (newSeq: number) => {
    setSeqDropdownOpen(false);
    const seqStr = String(newSeq).padStart(2, '0');
    navigate(`/${name}/${date}${seqStr}`, { replace: true });
  };

  const handlePageJump = () => {
    if (jumpToPageNum >= 1 && jumpToPageNum <= numPages) {
      setCurrentPage(jumpToPageNum);
      goToPage(jumpToPageNum);
      replacePageHash(jumpToPageNum);
    }
  };

  const handleDownload = async () => {
    if (!pdfUrl || downloading) return;

    setDownloading(true);
    try {
      const { bytes } = await fetchPdfDownloadBytes(pdfUrl, "auto");
      const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const blob = new Blob([arrayBuffer], { type: "application/pdf" });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = downloadFilename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    } catch (downloadError) {
      window.alert(String(downloadError instanceof Error ? downloadError.message : downloadError));
    } finally {
      setDownloading(false);
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
    if (!settingsOpen) return;

    const handleOutsideClick = (event: MouseEvent) => {
      if (!settingsRef.current?.contains(event.target as Node)) {
        setSettingsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [settingsOpen]);

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
  const toolbarActions = pdfUrl ? (
    <div ref={settingsRef} className="relative ml-auto flex shrink-0 items-center justify-end gap-1 sm:gap-2">
      <button
        type="button"
        onClick={() => {
          setZoomEnabled((enabled) => !enabled);
          setSettingsOpen(false);
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
      <button
        type="button"
        onClick={handleDownload}
        disabled={downloading}
        className="inline-flex h-8 items-center gap-1.5 border border-rule-dark bg-paper px-1.5 text-sm font-bold text-red transition-colors hover:border-red hover:text-red-dark disabled:cursor-wait disabled:opacity-60 sm:px-2.5"
        aria-label={downloading ? "下载中" : "下载 PDF"}
      >
        <DownloadIcon />
        <span className="hidden sm:inline">{downloading ? "下载中" : "下载"}</span>
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
        onClick={() => setSettingsOpen(!settingsOpen)}
        className="inline-flex h-8 items-center gap-1.5 border border-rule-dark bg-paper px-1.5 text-sm font-bold text-ink transition-colors hover:border-red hover:text-red sm:px-2.5"
        aria-label="设置"
        aria-expanded={settingsOpen}
      >
        <SettingsIcon />
        <span className="hidden sm:inline">设置</span>
      </button>
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
    <div ref={containerRef} data-reader-scroll-container className="h-full overflow-y-auto bg-paper">
      {/* SEO hidden heading */}
      <h1 className="hidden">{config?.label || name} - {id}</h1>

      {/* Toolbar: Magazine mode */}
      {type === "magazine" ? (
        <Toolbar sticky>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:flex-none sm:gap-2.5">
            <span className="hidden shrink-0 text-xs font-bold text-muted tracking-wide sm:inline sm:text-[13px]">日期</span>
            <YearPicker
              value={date}
              onChange={(y) => {
                const options = config?.seqConfig?.[y];
                const firstSeq = options?.[0] || 1;
                navigate(`/${name}/${y}${String(firstSeq).padStart(2, '0')}`);
              }}
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
        <Toolbar sticky>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:flex-none sm:gap-2.5">
            <span className="hidden shrink-0 text-xs font-bold text-muted tracking-wide sm:inline sm:text-[13px]">日期</span>
            <DatePicker
              value={date}
              onChange={(ds) => navigate(`/${name}/${ds}`)}
              disabledDate={config?.disabledDate}
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
        {loading && <LoadingSpinner text="正在加载 PDF 文档" fullscreen />}
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
            initialPage={initialPage}
            scrollContainerRef={containerRef}
            onPageChange={handleVisiblePageChange}
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
