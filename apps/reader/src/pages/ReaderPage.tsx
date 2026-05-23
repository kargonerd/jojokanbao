import { useParams, useNavigate } from "react-router-dom";
import { useState, useEffect, useRef } from "react";
import { usePdfDocument, PdfViewer } from "@jojo/pdf-viewer";
import { Button, LoadingSpinner } from "@jojo/ui";

const NEWSPAPER_HOST = "https://data.jojokanbao.cn";

interface ReaderPageProps {
  type: "newspaper" | "magazine";
  name: string;
}

export function ReaderPage({ type, name }: ReaderPageProps) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [date, setDate] = useState("");
  const [seq, setSeq] = useState(1);
  const [scale, setScale] = useState(window.innerWidth < 768 ? 1 : 2);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!id) return;
    if (type === "magazine") {
      setDate(id.substring(0, 4));
      setSeq(parseInt(id.substring(4)));
    } else {
      setDate(id);
    }
  }, [id, type]);

  const pdfUrl = date ? `${NEWSPAPER_HOST}/${name.toUpperCase()}/${date.substring(0, 4)}/${id}.pdf` : "";
  const { document: pdfDoc, loading, error, numPages } = usePdfDocument({ url: pdfUrl });

  const handleDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.replace(/-/g, "");
    if (val.length === 8) navigate(`/${name}/${val}`);
  };

  const handleYearChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const year = e.target.value;
    if (year.length === 4) navigate(`/${name}/${year}01`);
  };

  const scrollToTop = () => containerRef.current?.scrollTo({ top: 0, behavior: "smooth" });

  // Update document title
  useEffect(() => {
    const titles: Record<string, string> = { rmrb: "人民日报", ckxx: "参考消息", hq: "红旗", rmhb: "人民画报", sjzs: "世界知识" };
    document.title = `${titles[name] || name} ${id} - JOJO看报`;
  }, [name, id]);

  return (
    <div ref={containerRef} className="h-full overflow-y-auto bg-paper">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-4 py-3.5 px-4 border-b border-rule sticky top-0 bg-paper z-10">
        <div className="flex items-center gap-2.5">
          <span className="text-[13px] font-bold text-muted tracking-wide">日期</span>
          {type === "magazine" ? (
            <input type="number" value={date} min="1949" max="2000" className="h-8 w-[100px] text-sm" onChange={handleYearChange} />
          ) : (
            <input type="date" value={date ? `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}` : ""} className="h-8 text-sm" onChange={handleDateChange} />
          )}
        </div>
        {numPages > 0 && (
          <span className="text-xs text-muted">共 {numPages} 页</span>
        )}
        {pdfUrl && (
          <a href={pdfUrl} target="_blank" rel="noreferrer" className="text-sm font-bold text-red hover:text-red-dark ml-auto">下载</a>
        )}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">清晰度</span>
          <input type="range" min="1" max="4" value={scale} onChange={(e) => setScale(Number(e.target.value))} className="w-16 accent-[var(--color-red)]" />
        </div>
      </div>

      {/* Content */}
      <div className="px-4 py-4">
        {loading && <LoadingSpinner text="正在加载 PDF 文档" fullscreen />}
        {error && (
          <div className="py-20 text-center">
            <p className="text-muted font-bold">没有当天文档或数据缺失</p>
            <p className="text-sm text-muted mt-2">{error}</p>
          </div>
        )}
        {pdfDoc && <PdfViewer document={pdfDoc} scale={scale} />}
      </div>

      {/* Back to top */}
      <button
        className="fixed right-10 bottom-10 w-10 h-10 flex items-center justify-center border border-rule-dark bg-paper text-red hover:bg-red hover:text-cream transition-colors z-50"
        onClick={scrollToTop}
        aria-label="回到顶部"
      >
        <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 14V2m-5 5 5-5 5 5" /></svg>
      </button>
    </div>
  );
}
