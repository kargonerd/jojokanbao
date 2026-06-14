import { useParams, useNavigate } from "react-router-dom";
import { useState, useEffect, useRef, useCallback } from "react";
import { usePdfDocument, PdfViewer } from "@jojo/pdf-viewer";
import { LoadingSpinner, DatePicker, YearPicker } from "@jojo/ui";
import { PUBLICATIONS, type PublicationConfig } from "../publications";

const NEWSPAPER_HOST = "https://blacknews.jojokanbao.cn";

interface ReaderPageProps {
  type: "newspaper" | "magazine";
  name: string;
}

export function ReaderPage({ type, name }: ReaderPageProps) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const config: PublicationConfig = PUBLICATIONS[name];

  // ─── State ───
  const [date, setDate] = useState("");
  const [seq, setSeq] = useState(1);
  const [resolutionRate, setResolutionRate] = useState(window.innerWidth < 768 ? 1 : 2);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [jumpToPageNum, setJumpToPageNum] = useState(1);
  const [showBackTop, setShowBackTop] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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
  const { document: pdfDoc, loading, error, numPages } = usePdfDocument({ url: pdfUrl });

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
    return m ? parseInt(m[1]) : 0;
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

  return (
    <div ref={containerRef} className="h-full overflow-y-auto bg-paper">
      {/* SEO hidden heading */}
      <h1 className="hidden">{config?.label || name} - {id}</h1>

      {/* Toolbar: Magazine mode */}
      {type === "magazine" ? (
        <div className="flex flex-wrap items-center gap-4 py-3.5 px-4 border-b border-rule sticky top-0 bg-paper z-10">
          <div className="flex items-center gap-2.5">
            <span className="text-[13px] font-bold text-muted tracking-wide">日期</span>
            <YearPicker
              value={date}
              onChange={(y) => {
                const options = config?.seqConfig?.[y];
                const firstSeq = options?.[0] || 1;
                navigate(`/${name}/${y}${String(firstSeq).padStart(2, '0')}`);
              }}
              min={name === "sjzs" ? 1934 : name === "hq" ? 1958 : 1950}
              max={name === "hq" ? 1976 : name === "rmhb" ? 1976 : 2025}
            />
          </div>
          <div className="flex items-center gap-2.5">
            <span className="text-[13px] font-bold text-muted tracking-wide">期数</span>
            <select value={seq} className="h-8 text-sm min-w-[120px]" onChange={handleSeqChange}>
              {seqOptions.map((s) => (
                <option key={s} value={s}>{config?.genSeqText?.(s) || `第${s}期`}</option>
              ))}
            </select>
          </div>
          {pdfUrl && (
            <a href={pdfUrl} target="_blank" rel="noreferrer" className="ml-4 text-sm font-bold text-red hover:text-red-dark">下载</a>
          )}
        </div>
      ) : (
        /* Toolbar: Newspaper mode */
        <div className="flex flex-wrap items-center gap-4 py-3.5 px-4 border-b border-rule sticky top-0 bg-paper z-10">
          <div className="flex items-center gap-2.5">
            <span className="text-[13px] font-bold text-muted tracking-wide">日期</span>
            <DatePicker
              value={date}
              onChange={(ds) => navigate(`/${name}/${ds}`)}
              disabledDate={config?.disabledDate}
            />
          </div>
          {numPages > 0 && (
            <span className="text-xs text-muted">共 {numPages} 页</span>
          )}
          {pdfUrl && (
            <a href={pdfUrl} target="_blank" rel="noreferrer" className="ml-4 text-sm font-bold text-red hover:text-red-dark">下载</a>
          )}
        </div>
      )}

      {/* Content */}
      <div className="px-4 py-4">
        {loading && <LoadingSpinner text="正在加载 PDF 文档" fullscreen />}
        {error && (
          <div className="py-20 text-center">
            <p className="text-muted font-bold">没有当天文档或数据缺失</p>
            <p className="text-sm text-muted mt-2">{error}</p>
          </div>
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

      {/* Settings button (fixed) */}
      <div className="fixed right-10 top-[110px] z-50">
        <button
          className="w-9 h-9 flex items-center justify-center border border-rule-dark bg-paper text-ink hover:text-red hover:border-red transition-colors cursor-pointer"
          onClick={() => setSettingsOpen(!settingsOpen)}
          aria-label="设置"
        >
          <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
          </svg>
        </button>
        {settingsOpen && (
          <div className="absolute right-0 top-11 w-[220px] border border-rule-dark bg-paper p-4 space-y-4 shadow-none">
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
