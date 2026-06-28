import { useParams, useNavigate } from "react-router-dom";
import { useState, useEffect, useRef, useCallback } from "react";
import { fetchPdfDownloadBytes, usePdfDocument, PdfViewer } from "@jojo/pdf-viewer";
import { EmptyState, LoadingSpinner, DatePicker, Toolbar, YearPicker } from "@jojo/ui";
import { PUBLICATIONS, type PublicationConfig } from "../publications";

const NEWSPAPER_HOST = "https://blacknews.jojokanbao.cn";

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

interface ReaderPageProps {
  type: "newspaper" | "magazine";
  name: string;
}

export function ReaderPage({ type, name }: ReaderPageProps) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const config: PublicationConfig = PUBLICATIONS[name] ?? PUBLICATIONS.rmrb!;

  // ─── State ───
  const [date, setDate] = useState("");
  const [seq, setSeq] = useState(1);
  const [resolutionRate, setResolutionRate] = useState(window.innerWidth < 768 ? 1 : 2);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [jumpToPageNum, setJumpToPageNum] = useState(1);
  const [showBackTop, setShowBackTop] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const shareResetTimer = useRef<number | null>(null);

  // ─── PDF URL construction (matches original getPdfPath) ───
  const getPdfPath = useCallback(() => {
    let docId = date;
    const year = date.substring(0, 4);
    if (type === "magazine") {
      const seqStr = String(seq).padStart(2, '0');
      docId = date + seqStr;
    }
    return `/${name.toUpperCase()}/${year}/${docId}.pdf`;
  }, [date, seq, type, name]);

  const pdfUrl = date ? `${NEWSPAPER_HOST}${getPdfPath()}` : "";
  const { document: pdfDoc, loading, error, numPages } = usePdfDocument({ url: pdfUrl, protectedPdf: "auto" });
  const downloadFilename = `${name}-${type === "magazine" ? `${date}${String(seq).padStart(2, "0")}` : date}.pdf`;

  // ─── Route params → state ───
  useEffect(() => {
    if (!id) return;
    if (type === "magazine") {
      setDate(id.substring(0, 4));
      setSeq(parseInt(id.substring(4)));
    } else {
      setDate(id);
    }
  }, [id, type]);

  // ─── Hash navigation ───
  const getHashPageNum = useCallback((): number => {
    const m = /^#page-(\d+)$/i.exec(window.location.hash);
    return m?.[1] ? parseInt(m[1], 10) : 0;
  }, []);

  useEffect(() => {
    const handler = () => {
      const pageNum = getHashPageNum();
      if (pageNum && pdfDoc) {
        goToPage(pageNum);
      }
    };
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, [getHashPageNum, pdfDoc]);

  // Determine initial page from hash (for PdfViewer to render first)
  const hashPage = typeof window !== "undefined" ? getHashPageNum() : 0;
  const initialPage = hashPage > 1 ? hashPage : 1;

  // Scroll to hash page after PDF loads and page renders
  useEffect(() => {
    if (!pdfDoc || initialPage <= 1) return;
    // Retry scrolling until the target page element exists in DOM
    let attempts = 0;
    const tryScroll = () => {
      const el = document.querySelector(`#page-${initialPage}`);
      if (el) {
        el.scrollIntoView();
      } else if (attempts < 20) {
        attempts++;
        setTimeout(tryScroll, 200);
      }
    };
    setTimeout(tryScroll, 300);
  }, [pdfDoc]);

  // ─── Navigation handlers ───
  const handleDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.replace(/-/g, "");
    if (val.length === 8) navigate(`/${name}/${val}`);
  };

  const handleYearChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const year = e.target.value;
    if (year.length === 4) {
      const options = config?.seqConfig?.[year];
      const firstSeq = options?.[0] || 1;
      navigate(`/${name}/${year}${String(firstSeq).padStart(2, '0')}`);
    }
  };

  const handleSeqChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newSeq = parseInt(e.target.value);
    setSeq(newSeq);
    const seqStr = String(newSeq).padStart(2, '0');
    navigate(`/${name}/${date}${seqStr}`, { replace: true });
  };

  const handlePageJump = () => {
    if (jumpToPageNum >= 1 && jumpToPageNum <= numPages) {
      goToPage(jumpToPageNum);
      window.location.hash = `#page-${jumpToPageNum}`;
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

  const goToPage = useCallback((pageNum: number) => {
    const el = document.querySelector(`#page-${pageNum}`);
    if (el) {
      el.scrollIntoView();
    }
  }, []);

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

  // ─── Sync URL when date/seq changes ───
  const handleOptionChange = useCallback(() => {
    let id = date;
    if (type === "magazine") {
      const seqStr = String(seq).padStart(2, '0');
      id = date + seqStr;
    }
    navigate(`/${name}/${id}`, { replace: true });
  }, [date, seq, type, name, navigate]);

  // ─── Document title ───
  useEffect(() => {
    const titles: Record<string, string> = { rmrb: "人民日报", ckxx: "参考消息", hq: "红旗", rmhb: "人民画报", sjzs: "世界知识" };
    document.title = `${titles[name] || name} ${id} - JOJO看报`;
  }, [name, id]);

  // ─── Seq options for magazines ───
  const seqOptions = config?.seqConfig?.[date] || [];

  // ─── Date input validation ───
  const isDateDisabled = config?.disabledDate;
  const toolbarActions = pdfUrl ? (
    <div className="relative ml-auto flex shrink-0 items-center justify-end gap-1.5 sm:gap-2">
      <button
        type="button"
        onClick={handleDownload}
        disabled={downloading}
        className="inline-flex h-8 items-center gap-1.5 border border-rule-dark bg-paper px-2 text-sm font-bold text-red transition-colors hover:border-red hover:text-red-dark disabled:cursor-wait disabled:opacity-60 sm:px-2.5"
        aria-label={downloading ? "下载中" : "下载 PDF"}
      >
        <DownloadIcon />
        <span className="hidden sm:inline">{downloading ? "下载中" : "下载"}</span>
      </button>
      <button
        type="button"
        onClick={handleShare}
        className="hidden h-8 items-center gap-1.5 border border-rule-dark bg-paper px-2.5 text-sm font-bold text-ink transition-colors hover:border-red hover:text-red sm:inline-flex"
        aria-label={shareCopied ? "已复制阅读链接" : "复制阅读链接"}
        title={shareCopied ? "已复制阅读链接" : "复制阅读链接"}
      >
        <ShareIcon />
        <span>{shareCopied ? "已复制" : "分享"}</span>
      </button>
      <button
        type="button"
        onClick={() => setSettingsOpen(!settingsOpen)}
        className="inline-flex h-8 items-center gap-1.5 border border-rule-dark bg-paper px-2 text-sm font-bold text-ink transition-colors hover:border-red hover:text-red sm:px-2.5"
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
              <input type="range" min={1} max={5} value={resolutionRate} onChange={(e) => setResolutionRate(Number(e.target.value))} className="w-full accent-red" />
            </div>
          )}
        </div>
      )}
    </div>
  ) : null;

  return (
    <div ref={containerRef} className="h-full overflow-y-auto bg-paper">
      {/* SEO hidden heading */}
      <h1 className="hidden">{config?.label || name} - {id}</h1>

      {/* Toolbar: Magazine mode */}
      {type === "magazine" ? (
        <Toolbar sticky>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:flex-none sm:gap-2.5">
            <span className="shrink-0 text-xs font-bold text-muted tracking-wide sm:text-[13px]">日期</span>
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
          <div className="flex min-w-0 shrink-0 items-center gap-1.5 sm:gap-2.5">
            <span className="hidden text-xs font-bold text-muted tracking-wide min-[390px]:inline sm:text-[13px]">期数</span>
            <select value={seq} className="h-8 min-w-[92px] text-xs sm:min-w-[120px] sm:text-sm" onChange={handleSeqChange}>
              {seqOptions.map((s) => (
                <option key={s} value={s}>{config?.genSeqText?.(s) || `第${s}期`}</option>
              ))}
            </select>
          </div>
          {toolbarActions}
        </Toolbar>
      ) : (
        /* Toolbar: Newspaper mode */
        <Toolbar sticky>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:flex-none sm:gap-2.5">
            <span className="shrink-0 text-xs font-bold text-muted tracking-wide sm:text-[13px]">日期</span>
            <DatePicker
              value={date}
              onChange={(ds) => navigate(`/${name}/${ds}`)}
              disabledDate={config?.disabledDate}
              className="min-w-0 flex-1 sm:flex-none"
            />
          </div>
          {numPages > 0 && (
            <span className="hidden whitespace-nowrap text-xs text-muted min-[390px]:inline">共 {numPages} 页</span>
          )}
          {toolbarActions}
        </Toolbar>
      )}

      {/* Content */}
      <div className="px-4 py-4">
        {loading && <LoadingSpinner text="正在加载 PDF 文档" fullscreen />}
        {error && (
          <EmptyState title="没有当天文档或数据缺失" description={error} />
        )}
        {pdfDoc && (
          <PdfViewer
            document={pdfDoc}
            scale={resolutionRate * 2}
            initialPage={initialPage}
            onPageChange={(p) => {
              setJumpToPageNum(p);
            }}
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
