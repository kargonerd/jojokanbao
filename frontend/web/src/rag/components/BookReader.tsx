import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import "./BookReader.css";

export type BookReaderTheme = "paper" | "light" | "dark";
export type BookReaderMode = "paged" | "scroll";

export interface BookReaderChapter {
  id: string;
  title: string;
}

export interface BookReaderTocItem extends BookReaderChapter {
  targetId?: string;
  depth: number;
}

export interface BookReaderProps {
  bookTitle: string;
  characterCount: number;
  logicalChapterCount?: number;
  chapters: BookReaderChapter[];
  toc: BookReaderTocItem[];
  activeChapterId: string;
  chapterKey: string;
  focusAnchorId?: string;
  contentLoading?: boolean;
  error?: string;
  backHref: string;
  onChapterChange: (chapterId: string) => void;
  onDownload?: () => void;
  children: ReactNode;
}

interface PageMetrics {
  page: number;
  spreads: number;
  physicalPages: number;
  columnsPerSpread: number;
  step: number;
}

interface PageTurnSnapshot {
  direction: "next" | "previous";
  html: string;
  articleWidth: number;
  flowTop: number;
  flowLeft: number;
  flowWidth: number;
  flowHeight: number;
  scrollLeft: number;
}

const DEFAULT_PAGE_METRICS: PageMetrics = {
  page: 0,
  spreads: 1,
  physicalPages: 1,
  columnsPerSpread: 2,
  step: 0,
};

function storedTheme(): BookReaderTheme {
  const value = window.localStorage.getItem("jojo-reader-theme");
  return value === "light" || value === "dark" || value === "paper" ? value : "paper";
}

function storedMode(): BookReaderMode {
  const value = window.localStorage.getItem("jojo-reader-mode");
  if (value === "paged" || value === "scroll") return value;
  return window.innerWidth >= 900 ? "paged" : "scroll";
}

function storedFontSize(): number {
  const value = Number(window.localStorage.getItem("jojo-reader-font-size"));
  return value >= 14 && value <= 24 ? value : 17;
}

export function BookReader({
  bookTitle,
  characterCount,
  logicalChapterCount,
  chapters,
  toc,
  activeChapterId,
  chapterKey,
  focusAnchorId,
  contentLoading = false,
  error,
  backHref,
  onChapterChange,
  onDownload,
  children,
}: BookReaderProps) {
  const [fontSize, setFontSize] = useState(storedFontSize);
  const [theme, setTheme] = useState<BookReaderTheme>(storedTheme);
  const [mode, setMode] = useState<BookReaderMode>(storedMode);
  const [tocOpen, setTocOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [readingProgress, setReadingProgress] = useState(0);
  const [columnsPerSpread, setColumnsPerSpread] = useState(() => window.innerWidth >= 900 ? 2 : 1);
  const [pageMetrics, setPageMetrics] = useState<PageMetrics>(DEFAULT_PAGE_METRICS);
  const [turnSnapshot, setTurnSnapshot] = useState<PageTurnSnapshot>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const currentPageRef = useRef(0);
  const pendingPageRef = useRef<"start" | "end" | null>("start");
  const turnTimersRef = useRef<number[]>([]);

  const activeChapterIndex = Math.max(0, chapters.findIndex((chapter) => chapter.id === activeChapterId));
  const previousChapter = chapters[activeChapterIndex - 1];
  const nextChapter = chapters[activeChapterIndex + 1];
  const bookProgress = chapters.length
    ? Math.min(100, Math.round(((activeChapterIndex + readingProgress / 100) / chapters.length) * 100))
    : 0;

  const measurePages = useCallback(() => {
    const flow = flowRef.current;
    if (!flow || mode !== "paged") return;
    const gap = Number.parseFloat(window.getComputedStyle(flow).columnGap) || 64;
    const columnStep = (flow.clientWidth + gap) / columnsPerSpread;
    const physicalPages = Math.max(1, Math.ceil((flow.scrollWidth + gap - 1) / columnStep));
    const spreads = Math.max(1, Math.ceil(physicalPages / columnsPerSpread));
    const step = flow.clientWidth + gap;
    const requestedPage = pendingPageRef.current === "end"
      ? spreads - 1
      : pendingPageRef.current === "start"
        ? 0
        : Math.min(currentPageRef.current, spreads - 1);
    pendingPageRef.current = null;
    currentPageRef.current = requestedPage;
    flow.scrollLeft = requestedPage * step;
    setPageMetrics({ page: requestedPage, spreads, physicalPages, columnsPerSpread, step });
    setReadingProgress(spreads <= 1 ? 100 : Math.round((requestedPage / (spreads - 1)) * 100));
  }, [columnsPerSpread, mode]);

  useEffect(() => {
    window.localStorage.setItem("jojo-reader-font-size", String(fontSize));
  }, [fontSize]);

  useEffect(() => {
    window.localStorage.setItem("jojo-reader-theme", theme);
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem("jojo-reader-mode", mode);
  }, [mode]);

  useEffect(() => () => {
    turnTimersRef.current.forEach((timer) => window.clearTimeout(timer));
  }, []);

  useEffect(() => {
    const closePanels = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setTocOpen(false);
      setSettingsOpen(false);
    };
    window.addEventListener("keydown", closePanels);
    return () => window.removeEventListener("keydown", closePanels);
  }, []);

  useEffect(() => {
    const updateColumns = (): void => setColumnsPerSpread(window.innerWidth >= 900 ? 2 : 1);
    window.addEventListener("resize", updateColumns);
    return () => window.removeEventListener("resize", updateColumns);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    flowRef.current?.scrollTo({ left: 0 });
    currentPageRef.current = 0;
    if (pendingPageRef.current === null) pendingPageRef.current = "start";
    setReadingProgress(0);
    setPageMetrics((current) => ({ ...current, page: 0 }));
  }, [chapterKey]);

  useEffect(() => {
    currentPageRef.current = 0;
    scrollRef.current?.scrollTo({ top: 0 });
    flowRef.current?.scrollTo({ left: 0 });
    setReadingProgress(0);
    setPageMetrics((current) => ({ ...current, page: 0 }));
  }, [mode]);

  useLayoutEffect(() => {
    if (mode !== "paged" || contentLoading) return;
    const frame = window.requestAnimationFrame(measurePages);
    const timer = window.setTimeout(measurePages, 120);
    const flow = flowRef.current;
    const observer = flow ? new ResizeObserver(measurePages) : undefined;
    if (flow && observer) observer.observe(flow);
    const mutationObserver = flow ? new MutationObserver(measurePages) : undefined;
    if (flow && mutationObserver) mutationObserver.observe(flow, { childList: true, subtree: true, attributes: true });
    flow?.querySelectorAll("img").forEach((image) => image.addEventListener("load", measurePages));
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      observer?.disconnect();
      mutationObserver?.disconnect();
      flow?.querySelectorAll("img").forEach((image) => image.removeEventListener("load", measurePages));
    };
  }, [children, contentLoading, fontSize, measurePages, theme]);

  const goToPage = useCallback((page: number, behavior: ScrollBehavior = "smooth") => {
    const bounded = Math.max(0, Math.min(page, pageMetrics.spreads - 1));
    flowRef.current?.scrollTo({ left: bounded * pageMetrics.step, behavior });
    currentPageRef.current = bounded;
    setPageMetrics((current) => ({ ...current, page: bounded }));
    setReadingProgress(pageMetrics.spreads <= 1 ? 100 : Math.round((bounded / (pageMetrics.spreads - 1)) * 100));
  }, [pageMetrics.spreads, pageMetrics.step]);

  const chooseChapter = useCallback((chapterId: string | undefined, destination: "start" | "end" = "start"): void => {
    if (!chapterId) return;
    pendingPageRef.current = destination;
    onChapterChange(chapterId);
    setTocOpen(false);
  }, [onChapterChange]);

  function changeMode(value: BookReaderMode): void {
    if (value === mode) return;
    pendingPageRef.current = "start";
    currentPageRef.current = 0;
    setMode(value);
  }

  const beginPageTurn = useCallback((direction: "next" | "previous", applyTurn: () => void) => {
    if (turnSnapshot) return;
    const flow = flowRef.current;
    const article = articleRef.current;
    if (!flow || !article || typeof window.matchMedia !== "function" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      applyTurn();
      return;
    }
    turnTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    setTurnSnapshot({
      direction,
      html: flow.innerHTML,
      articleWidth: article.clientWidth,
      flowTop: flow.offsetTop,
      flowLeft: flow.offsetLeft,
      flowWidth: flow.clientWidth,
      flowHeight: flow.clientHeight,
      scrollLeft: flow.scrollLeft,
    });
    turnTimersRef.current = [
      window.setTimeout(applyTurn, 250),
      window.setTimeout(() => setTurnSnapshot(undefined), 560),
    ];
  }, [turnSnapshot]);

  const previousPage = useCallback(() => {
    if (turnSnapshot) return;
    if (pageMetrics.page > 0) beginPageTurn("previous", () => goToPage(pageMetrics.page - 1, "auto"));
    else if (previousChapter) beginPageTurn("previous", () => chooseChapter(previousChapter.id, "end"));
  }, [beginPageTurn, chooseChapter, goToPage, pageMetrics.page, previousChapter, turnSnapshot]);

  const nextPage = useCallback(() => {
    if (turnSnapshot) return;
    if (pageMetrics.page < pageMetrics.spreads - 1) beginPageTurn("next", () => goToPage(pageMetrics.page + 1, "auto"));
    else if (nextChapter) beginPageTurn("next", () => chooseChapter(nextChapter.id));
  }, [beginPageTurn, chooseChapter, goToPage, nextChapter, pageMetrics.page, pageMetrics.spreads, turnSnapshot]);

  useEffect(() => {
    if (mode !== "paged") return;
    const turnWithKeyboard = (event: KeyboardEvent): void => {
      const target = event.target;
      if (target instanceof HTMLElement && target.matches("input, textarea, select, button")) return;
      if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        previousPage();
      }
      if (event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ") {
        event.preventDefault();
        nextPage();
      }
    };
    window.addEventListener("keydown", turnWithKeyboard);
    return () => window.removeEventListener("keydown", turnWithKeyboard);
  }, [mode, nextPage, previousPage]);

  const revealAnchor = useCallback((anchorId: string, behavior: ScrollBehavior = "smooth") => {
    const target = document.getElementById(anchorId);
    if (!target) return;
    if (mode === "scroll") {
      target.scrollIntoView({ behavior, block: "center" });
      return;
    }
    const flow = flowRef.current;
    if (!flow || !pageMetrics.step) return;
    const targetLeft = target.getBoundingClientRect().left - flow.getBoundingClientRect().left + flow.scrollLeft;
    goToPage(Math.floor(targetLeft / pageMetrics.step), behavior);
  }, [goToPage, mode, pageMetrics.step]);

  useEffect(() => {
    if (!focusAnchorId || contentLoading) return;
    const timer = window.setTimeout(() => revealAnchor(focusAnchorId), 80);
    return () => window.clearTimeout(timer);
  }, [contentLoading, focusAnchorId, pageMetrics.step, revealAnchor]);

  function handleInternalLink(event: ReactMouseEvent<HTMLDivElement>): void {
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#"]');
    if (!link) return;
    const anchorId = decodeURIComponent(link.getAttribute("href")?.slice(1) || "");
    if (!anchorId || !document.getElementById(anchorId)) return;
    event.preventDefault();
    revealAnchor(anchorId);
  }

  function updateScrollProgress(): void {
    const reader = scrollRef.current;
    if (!reader) return;
    const range = reader.scrollHeight - reader.clientHeight;
    setReadingProgress(range <= 0 ? 100 : Math.min(100, Math.round((reader.scrollTop / range) * 100)));
  }

  const shellClass = theme === "dark" ? "bg-[#151716] text-[#deded8]" : theme === "light" ? "bg-[#edf0f0] text-ink" : "bg-[#e8e9e4] text-ink";
  const pageClass = theme === "dark" ? "bg-[#202321]" : theme === "light" ? "bg-white" : "bg-[#fbfaf6]";
  const panelClass = theme === "dark" ? "bg-[#242725] text-[#deded8] border-[#393d3a]" : "bg-[#fbfaf6] text-ink border-[#d8d8d1]";
  const chromeClass = theme === "dark" ? "border-[#303431] bg-[#151716]/90" : theme === "light" ? "border-[#d6d8d3] bg-[#edf0f0]/90" : "border-[#d6d8d3] bg-[#e8e9e4]/90";
  const controlClass = `h-12 w-12 border flex items-center justify-center bg-transparent cursor-pointer font-sans text-xs transition-colors focus-visible:outline-2 focus-visible:outline-red ${theme === "dark" ? "border-[#444844] hover:bg-[#2b2f2c]" : "border-[#d2d3ce] hover:bg-white"}`;
  const firstPhysicalPage = pageMetrics.page * pageMetrics.columnsPerSpread + 1;
  const lastPhysicalPage = Math.min(firstPhysicalPage + pageMetrics.columnsPerSpread - 1, pageMetrics.physicalPages);

  const chapterNavigation = !contentLoading && <nav aria-label="章节导航" className="mt-20 grid grid-cols-2 border-t border-rule pt-8 font-sans text-xs [break-inside:avoid]">
    <button type="button" disabled={!previousChapter} onClick={() => chooseChapter(previousChapter?.id, "end")} className="border-0 bg-transparent py-4 pr-4 text-left text-current cursor-pointer disabled:cursor-default disabled:opacity-30"><span className="mb-1 block text-muted">上一节</span>{previousChapter?.title ?? "已经是第一节"}</button>
    <button type="button" disabled={!nextChapter} onClick={() => chooseChapter(nextChapter?.id)} className="border-0 border-l border-rule bg-transparent py-4 pl-4 text-right text-current cursor-pointer disabled:cursor-default disabled:opacity-30"><span className="mb-1 block text-muted">下一节</span>{nextChapter?.title ?? "已经是最后一节"}</button>
  </nav>;

  return <div className={`h-screen overflow-hidden ${shellClass}`}>
    <nav data-book-toolbar aria-label="阅读工具" className="fixed right-5 top-1/2 z-30 hidden -translate-y-1/2 flex-col gap-2 md:flex">
      <button type="button" onClick={() => { setTocOpen(true); setSettingsOpen(false); }} className={controlClass} aria-label="打开目录" title="目录">目录</button>
      <Link to={backHref} className={`${controlClass} no-underline text-current`} aria-label="向 AI 提问" title="向 AI 提问">AI</Link>
      <button type="button" onClick={() => { setSettingsOpen((value) => !value); setTocOpen(false); }} className={controlClass} aria-label="阅读设置" title="阅读设置">Aa</button>
      <button type="button" onClick={() => changeMode(mode === "paged" ? "scroll" : "paged")} className={controlClass} aria-label="切换阅读模式" title="切换阅读模式">{mode === "paged" ? "双页" : "滚动"}</button>
    </nav>

    {tocOpen && <>
      <button type="button" aria-label="关闭目录" onClick={() => setTocOpen(false)} className="fixed inset-0 z-40 border-0 bg-black/20 cursor-default" />
      <aside className={`fixed inset-y-0 left-0 z-50 w-[min(88vw,390px)] overflow-y-auto border-r shadow-[18px_0_50px_rgba(0,0,0,.12)] ${panelClass}`}>
        <div className={`sticky top-0 z-10 border-b px-7 py-6 ${panelClass}`}>
          <div className="flex items-start justify-between gap-4">
            <div><p className="m-0 font-sans text-[11px] tracking-[.22em] text-muted">目录</p><h2 className="mb-1 mt-2 text-xl leading-snug">{bookTitle}</h2><p className="m-0 font-sans text-xs text-muted">{logicalChapterCount ? `${logicalChapterCount} 章 · ` : ""}{characterCount.toLocaleString()} 字</p></div>
            <button type="button" onClick={() => setTocOpen(false)} className="border-0 bg-transparent text-2xl cursor-pointer text-current" aria-label="关闭目录">×</button>
          </div>
        </div>
        <ol className="m-0 list-none px-4 py-5">{toc.map((item) => <li key={item.id}><button type="button" onClick={() => chooseChapter(item.targetId)} style={{ paddingLeft: `${16 + item.depth * 16}px` }} className={`relative block w-full border-0 bg-transparent py-2.5 pr-4 text-left font-serif text-[13px] leading-relaxed cursor-pointer ${activeChapterId === item.targetId ? "font-bold text-red before:absolute before:inset-y-2 before:left-0 before:w-[2px] before:bg-red" : "text-current hover:text-red"}`}>{item.title}</button></li>)}</ol>
      </aside>
    </>}

    {settingsOpen && <>
      <button type="button" aria-label="关闭阅读设置" onClick={() => setSettingsOpen(false)} className="fixed inset-0 z-30 border-0 bg-black/10 cursor-default" />
      <section className={`fixed inset-x-4 bottom-4 z-40 border p-5 shadow-[8px_12px_35px_rgba(0,0,0,.14)] md:inset-x-auto md:bottom-auto md:right-20 md:top-1/2 md:w-72 md:-translate-y-1/2 ${panelClass}`} aria-label="阅读设置">
        <div className="mb-5 flex items-center justify-between"><h2 className="m-0 font-sans text-sm">阅读设置</h2><button type="button" onClick={() => setSettingsOpen(false)} className="border-0 bg-transparent text-xl cursor-pointer text-current" aria-label="关闭设置">×</button></div>
        <div className="mb-2 font-sans text-xs text-muted">阅读方式</div>
        <div className="mb-6 grid grid-cols-2 gap-2">{(["paged", "scroll"] as BookReaderMode[]).map((value) => <button type="button" key={value} onClick={() => changeMode(value)} className={`h-10 border bg-transparent text-current cursor-pointer ${mode === value ? "border-red font-bold text-red outline outline-1 outline-red" : "border-rule"}`}>{value === "paged" ? "双栏翻页" : "上下滚动"}</button>)}</div>
        <label className="mb-2 flex items-center justify-between font-sans text-xs text-muted"><span>字号</span><span>{fontSize}px</span></label>
        <input type="range" min="14" max="24" value={fontSize} onChange={(event) => setFontSize(+event.target.value)} className="mb-6 w-full accent-[var(--color-red)]" />
        <div className="mb-2 font-sans text-xs text-muted">纸张</div>
        <div className="grid grid-cols-3 gap-2">{(["paper", "light", "dark"] as BookReaderTheme[]).map((value) => <button type="button" key={value} onClick={() => setTheme(value)} className={`h-10 border cursor-pointer ${value === "paper" ? "bg-[#fbfaf6] text-ink" : value === "light" ? "bg-white text-ink" : "bg-[#202321] text-white"} ${theme === value ? "border-red outline outline-1 outline-red" : "border-rule"}`}>{value === "paper" ? "纸张" : value === "light" ? "明亮" : "夜间"}</button>)}</div>
        {onDownload && <button type="button" className="mt-6 w-full border border-red bg-transparent py-2.5 font-sans text-xs font-bold text-red cursor-pointer hover:bg-red hover:text-white" onClick={onDownload}>下载整本 EPUB</button>}
      </section>
    </>}

    <header className={`relative z-20 h-12 border-b backdrop-blur-md ${chromeClass}`}>
      <div className="mx-auto flex h-full max-w-[1180px] items-center gap-3 px-4 font-sans text-xs md:px-10">
        <Link to={backHref} className="text-current no-underline" aria-label="返回问答">←</Link>
        <button type="button" onClick={() => setTocOpen(true)} className="border-0 bg-transparent p-0 font-sans text-xs text-current cursor-pointer md:hidden">目录</button>
        <span className="min-w-0 flex-1 truncate text-muted">{bookTitle}</span>
        <span className="hidden max-w-[42%] truncate text-muted sm:block">{chapters[activeChapterIndex]?.title}</span>
        <button type="button" onClick={() => changeMode(mode === "paged" ? "scroll" : "paged")} className="border-0 bg-transparent p-0 font-sans text-xs text-current cursor-pointer md:hidden">{mode === "paged" ? "翻页" : "滚动"}</button>
        <button type="button" onClick={() => setSettingsOpen((value) => !value)} className="border-0 bg-transparent p-0 font-sans text-xs text-current cursor-pointer md:hidden">Aa</button>
        {mode === "scroll" && <span className="tabular-nums text-muted">全书 {bookProgress}%</span>}
        <span className="tabular-nums text-muted">全书 {bookProgress}%</span>
      </div>
    </header>

    {mode === "scroll" ? <div ref={scrollRef} onScroll={updateScrollProgress} onClick={handleInternalLink} className="h-[calc(100%-48px)] overflow-y-auto scroll-smooth">
      <main className="mx-auto max-w-[920px] px-0 py-0 md:px-5 md:py-8">
        <article className={`relative min-h-[calc(100vh-96px)] border-x px-6 py-12 shadow-[0_16px_50px_rgba(32,32,28,.10)] sm:px-12 md:px-20 md:py-20 ${pageClass} ${theme === "dark" ? "border-[#2d312e]" : "border-[#ddddd6]"}`} style={{ fontSize: `${fontSize}px`, lineHeight: 2.05 }}>
          <div className="mx-auto max-w-[730px]">{error && <p className="border-l-4 border-red bg-red/5 px-4 py-3 text-sm text-red">{error}</p>}{children}{chapterNavigation}</div>
        </article>
      </main>
    </div> : <main className="relative h-[calc(100%-48px)] px-3 py-3 sm:px-8 sm:py-5 md:px-20 md:py-6">
      <div className="relative mx-auto h-full max-w-[1180px]">
        <article ref={articleRef} className={`relative h-full overflow-hidden border px-7 py-10 shadow-[0_16px_55px_rgba(32,32,28,.14)] sm:px-12 md:px-16 md:py-14 ${pageClass} ${theme === "dark" ? "border-[#2d312e]" : "border-[#d8d8d1]"}`}>
          {columnsPerSpread === 2 && <div className={`pointer-events-none absolute inset-y-0 left-1/2 z-10 w-10 -translate-x-1/2 ${theme === "dark" ? "bg-[linear-gradient(90deg,transparent,rgba(0,0,0,.22),transparent)]" : "bg-[linear-gradient(90deg,transparent,rgba(77,75,66,.09),transparent)]"}`} aria-hidden="true" />}
          <div ref={flowRef} data-book-page-flow onClick={handleInternalLink} className="h-full overflow-hidden [column-fill:auto] [&_figure]:break-inside-avoid [&_h1]:[break-after:avoid-column] [&_h2]:[break-after:avoid-column] [&_li]:break-inside-avoid" style={{ columnCount: columnsPerSpread, columnGap: columnsPerSpread === 2 ? "80px" : "48px", fontSize: `${fontSize}px`, lineHeight: 1.95 }}>
            {error && <p className="border-l-4 border-red bg-red/5 px-4 py-3 text-sm text-red">{error}</p>}{children}
          </div>
        </article>
        {turnSnapshot && <div className="book-page-turn-stage" aria-hidden="true">
          <div className={`book-page-turn-sheet book-page-turn-sheet--${turnSnapshot.direction} ${pageClass}`}>
            <div className="book-page-turn-face book-page-turn-face--front">
              <div
                className="absolute [column-fill:auto]"
                style={{
                  top: `${turnSnapshot.flowTop}px`,
                  left: `${turnSnapshot.flowLeft - (turnSnapshot.direction === "next" ? turnSnapshot.articleWidth / 2 : 0) - turnSnapshot.scrollLeft}px`,
                  width: `${turnSnapshot.flowWidth}px`,
                  height: `${turnSnapshot.flowHeight}px`,
                  columnCount: columnsPerSpread,
                  columnGap: columnsPerSpread === 2 ? "80px" : "48px",
                  fontSize: `${fontSize}px`,
                  lineHeight: 1.95,
                }}
                dangerouslySetInnerHTML={{ __html: turnSnapshot.html }}
              />
            </div>
            <div className="book-page-turn-face book-page-turn-face--back" />
          </div>
        </div>}
        <button type="button" onClick={previousPage} disabled={Boolean(turnSnapshot) || (!previousChapter && pageMetrics.page === 0)} className={`absolute bottom-4 left-5 z-30 flex h-9 items-center justify-center gap-1 border px-3 font-sans text-xs shadow-[2px_4px_14px_rgba(0,0,0,.08)] cursor-pointer transition-colors disabled:cursor-default disabled:opacity-20 sm:left-8 ${panelClass}`} aria-label="上一页" title="上一页（←）"><span aria-hidden="true">‹</span> 上一页</button>
        <button type="button" onClick={nextPage} disabled={Boolean(turnSnapshot) || (!nextChapter && pageMetrics.page >= pageMetrics.spreads - 1)} className={`absolute bottom-4 right-5 z-30 flex h-9 items-center justify-center gap-1 border px-3 font-sans text-xs shadow-[2px_4px_14px_rgba(0,0,0,.08)] cursor-pointer transition-colors disabled:cursor-default disabled:opacity-20 sm:right-8 ${panelClass}`} aria-label="下一页" title="下一页（→ 或空格）">下一页 <span aria-hidden="true">›</span></button>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-1 flex items-center justify-center gap-4 font-sans text-[10px] text-muted md:bottom-2">
        <span>{firstPhysicalPage === lastPhysicalPage ? firstPhysicalPage : `${firstPhysicalPage}–${lastPhysicalPage}`} / {pageMetrics.physicalPages} 页</span><span className="hidden sm:inline">按 ← → 或空格翻页</span><span>全书 {bookProgress}%</span>
      </div>
    </main>}
  </div>;
}
