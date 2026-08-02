import { useParams } from "react-router-dom";
import { useState, useEffect } from "react";
import { catalogApi } from "../api";
import { renderMarkdown } from "../utils/markdown";
import { LoadingSpinner } from "@jojo/ui";
import type { RagSourceDocument } from "../types";

type ReaderTheme = "paper" | "light" | "dark";

function isReaderTheme(value: string): value is ReaderTheme {
  return value === "paper" || value === "light" || value === "dark";
}

export function resolveChapterText(payload: string | { text?: string } | null | undefined): string {
  if (typeof payload === "string") return payload;
  return payload?.text ?? "";
}

export function ReaderPage() {
  const { notebookId, sourceId } = useParams<{ notebookId: string; sourceId: string }>();
  const [doc, setDoc] = useState<RagSourceDocument | null>(null);
  const [chapters, setChapters] = useState<Record<string, string>>({});
  const [activeChapter, setActiveChapter] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [fontSize, setFontSize] = useState(16);
  const [theme, setTheme] = useState<ReaderTheme>("paper");

  useEffect(() => {
    if (!notebookId || !sourceId) return;
    setLoading(true);
    catalogApi.getSourceDocument(notebookId, sourceId).then((data) => {
      setDoc(data);
      const firstChapter = data.toc?.[0];
      if (firstChapter) setActiveChapter(firstChapter.id);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [notebookId, sourceId]);

  useEffect(() => {
    if (!notebookId || !sourceId || !activeChapter) return;
    if (chapters[activeChapter]) return;
    catalogApi.getSourceChapter(notebookId, sourceId, activeChapter).then((payload) => {
      setChapters((prev) => ({ ...prev, [activeChapter]: resolveChapterText(payload) }));
    });
  }, [activeChapter, chapters, notebookId, sourceId]);

  if (loading) return <LoadingSpinner text="加载文档中" fullscreen />;
  if (!doc) return <div className="p-8 text-center text-muted">文档不存在</div>;

  const bgClass = theme === "dark" ? "bg-[#1a1a1a] text-[#e0e0e0]" : theme === "light" ? "bg-white text-ink" : "bg-paper-soft text-ink";

  return (
    <div className="h-screen flex">
      {/* TOC sidebar */}
      <aside className="w-56 shrink-0 border-r border-rule overflow-y-auto bg-paper p-4 hidden md:block">
        <h2 className="text-sm font-bold text-red tracking-wider mb-3">{doc.title}</h2>
        <ul className="list-none m-0 p-0 space-y-0.5">
          {doc.toc?.map((item) => (
            <li key={item.id}>
              <button onClick={() => setActiveChapter(item.id)} className={`block w-full text-left px-2 py-1.5 text-xs border-0 bg-transparent transition-colors ${activeChapter === item.id ? "text-red font-bold" : "text-ink hover:text-red"}`}>
                {item.title}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {/* Content */}
      <div className={`flex-1 overflow-y-auto ${bgClass}`}>
        {/* Toolbar */}
        <div className="sticky top-0 z-10 flex items-center gap-4 px-6 py-2 border-b border-rule bg-paper/90 backdrop-blur-sm">
          <label className="text-xs text-muted flex items-center gap-1">
            字号 <input type="range" min="14" max="22" value={fontSize} onChange={(e) => setFontSize(+e.target.value)} className="w-16 accent-[var(--color-red)]" />
          </label>
          <select value={theme} onChange={(event) => { if (isReaderTheme(event.target.value)) setTheme(event.target.value); }} className="h-7 text-xs px-2">
            <option value="paper">纸张</option>
            <option value="light">明亮</option>
            <option value="dark">暗色</option>
          </select>
        </div>

        {/* Chapter content */}
        <article className="max-w-3xl mx-auto px-6 py-8" style={{ fontSize: `${fontSize}px`, lineHeight: 1.9 }}>
          {chapters[activeChapter] ? (
            <div className="prose-editorial" dangerouslySetInnerHTML={{ __html: renderMarkdown(chapters[activeChapter]) }} />
          ) : (
            <LoadingSpinner text="加载章节中" />
          )}
        </article>
      </div>
    </div>
  );
}
