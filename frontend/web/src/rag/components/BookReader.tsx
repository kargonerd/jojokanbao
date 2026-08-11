import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
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

interface ExpandedImage {
  src: string;
  alt: string;
}

interface PageMetrics {
  page: number;
  spreads: number;
  physicalPages: number;
  columnsPerSpread: number;
  step: number;
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
  const [tocQuery, setTocQuery] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ExpandedImage>();
  const [readingProgress, setReadingProgress] = useState(0);
  const [columnsPerSpread, setColumnsPerSpread] = useState(() => window.innerWidth >= 900 ? 2 : 1);
  const [pageMetrics, setPageMetrics] = useState<PageMetrics>(DEFAULT_PAGE_METRICS);
  const [trailingBlankPage, setTrailingBlankPage] = useState(false);
  const [pageTransitioning, setPageTransitioning] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<HTMLDivElement>(null);
  const tocPanelRef = useRef<HTMLElement>(null);
  const currentPageRef = useRef(0);
  const pendingPageRef = useRef<"start" | "end" | null>("start");
  const transitionTimerRef = useRef<number | undefined>(undefined);

  const activeChapterIndex = Math.max(0, chapters.findIndex((chapter) => chapter.id === activeChapterId));
  const previousChapter = chapters[activeChapterIndex - 1];
  const nextChapter = chapters[activeChapterIndex + 1];
  const bookProgress = chapters.length
    ? Math.min(100, Math.round(((activeChapterIndex + readingProgress / 100) / chapters.length) * 100))
    : 0;
  const filteredToc = useMemo(() => {
    const query = tocQuery.normalize("NFKC").trim().toLocaleLowerCase();
    if (!query) return toc;
    return toc.filter((item) => item.title.normalize("NFKC").toLocaleLowerCase().includes(query));
  }, [toc, tocQuery]);

  const measurePages = useCallback(() => {
    const flow = flowRef.current;
    if (!flow || mode !== "paged") return;
    const gap = Number.parseFloat(window.getComputedStyle(flow).columnGap) || 64;
    const columnStep = (flow.clientWidth + gap) / columnsPerSpread;
    const measuredPages = Math.max(1, Math.ceil((flow.scrollWidth + gap - 1) / columnStep));
    const physicalPages = Math.max(1, measuredPages - (trailingBlankPage ? 1 : 0));
    const needsTrailingBlankPage = columnsPerSpread === 2 && physicalPages % 2 === 1;
    if (needsTrailingBlankPage !== trailingBlankPage) setTrailingBlankPage(needsTrailingBlankPage);
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
  }, [columnsPerSpread, mode, trailingBlankPage]);

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
    if (transitionTimerRef.current) window.clearTimeout(transitionTimerRef.current);
  }, []);

  useEffect(() => {
    if (!tocOpen || tocQuery) return;
    const frame = window.requestAnimationFrame(() => {
      tocPanelRef.current?.querySelector<HTMLElement>("[data-toc-active='true']")?.scrollIntoView({ block: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [tocOpen, tocQuery]);

  useEffect(() => {
    const closePanels = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setTocOpen(false);
      setSettingsOpen(false);
      setExpandedImage(undefined);
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
    setExpandedImage(undefined);
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

  const changePageWithFade = useCallback((applyChange: () => void) => {
    if (pageTransitioning) return;
    applyChange();
    if (typeof window.matchMedia !== "function" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (transitionTimerRef.current) window.clearTimeout(transitionTimerRef.current);
    setPageTransitioning(true);
    transitionTimerRef.current = window.setTimeout(() => setPageTransitioning(false), 160);
  }, [pageTransitioning]);

  const previousPage = useCallback(() => {
    if (pageTransitioning) return;
    if (pageMetrics.page > 0) changePageWithFade(() => goToPage(pageMetrics.page - 1, "auto"));
    else if (previousChapter) changePageWithFade(() => chooseChapter(previousChapter.id, "end"));
  }, [changePageWithFade, chooseChapter, goToPage, pageMetrics.page, pageTransitioning, previousChapter]);

  const nextPage = useCallback(() => {
    if (pageTransitioning) return;
    if (pageMetrics.page < pageMetrics.spreads - 1) changePageWithFade(() => goToPage(pageMetrics.page + 1, "auto"));
    else if (nextChapter) changePageWithFade(() => chooseChapter(nextChapter.id));
  }, [changePageWithFade, chooseChapter, goToPage, nextChapter, pageMetrics.page, pageMetrics.spreads, pageTransitioning]);

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

  function handleReaderClick(event: ReactMouseEvent<HTMLDivElement>): void {
    const image = (event.target as Element).closest<HTMLImageElement>("img");
    if (image) {
      event.preventDefault();
      setExpandedImage({ src: image.currentSrc || image.src, alt: image.alt });
      return;
    }
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
      <button type="button" onClick={() => { setTocOpen(true); setSettingsOpen(false); }} className={controlClass} aria-label="打开目录" title="目录"><span className="flex flex-col gap-[3px]" aria-hidden="true"><i className="block h-px w-5 bg-current" /><i className="block h-px w-5 bg-current" /><i className="block h-px w-5 bg-current" /></span></button>
      <Link to={backHref} className={`${controlClass} no-underline text-current`} aria-label="向 AI 提问" title="向 AI 提问">AI</Link>
      <button type="button" onClick={() => { setSettingsOpen((value) => !value); setTocOpen(false); }} className={controlClass} aria-label="阅读设置" title="阅读设置"><svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true"><path d="M4 6h7m4 0h5M4 12h3m4 0h9M4 18h9m4 0h3" fill="none" stroke="currentColor" strokeWidth="1.5" /><circle cx="13" cy="6" r="2" fill="none" stroke="currentColor" strokeWidth="1.5" /><circle cx="9" cy="12" r="2" fill="none" stroke="currentColor" strokeWidth="1.5" /><circle cx="15" cy="18" r="2" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg></button>
      <button type="button" data-reader-mode={mode} onClick={() => changeMode(mode === "paged" ? "scroll" : "paged")} className={controlClass} aria-label="切换阅读模式" title={mode === "paged" ? "切换为上下滚动" : "切换为双页阅读"}><span className="font-sans text-[11px] tracking-[.08em]" aria-hidden="true">{mode === "paged" ? "双页" : "滚动"}</span></button>
      {onDownload && <button type="button" onClick={onDownload} className={`${controlClass} mt-3`} aria-label="下载整本 EPUB" title="下载整本 EPUB"><svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 20h14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" /></svg></button>}
    </nav>

    {tocOpen && <>
      <button type="button" aria-label="关闭目录" onClick={() => setTocOpen(false)} className="fixed inset-0 z-40 border-0 bg-black/20 cursor-default" />
      <aside ref={tocPanelRef} aria-label="目录面板" className={`fixed inset-y-0 right-0 z-50 w-full overflow-y-auto border-l shadow-[-18px_0_50px_rgba(0,0,0,.12)] sm:w-[min(88vw,420px)] ${panelClass}`}>
        <div className={`sticky top-0 z-10 border-b px-7 py-6 ${panelClass}`}>
          <div className="flex items-start justify-between gap-4">
            <div><p className="m-0 font-sans text-[11px] tracking-[.22em] text-muted">目录</p><h2 className="mb-1 mt-2 text-xl leading-snug">{bookTitle}</h2><p className="m-0 font-sans text-xs text-muted">{logicalChapterCount ? `${logicalChapterCount} 章 · ` : ""}{characterCount.toLocaleString()} 字</p></div>
            <button type="button" onClick={() => setTocOpen(false)} className="border-0 bg-transparent text-2xl cursor-pointer text-current" aria-label="关闭目录">×</button>
          </div>
          <label className={`book-toc-search-shell mt-5 flex h-10 items-center gap-3 border-0 border-b px-0 font-sans text-xs ${theme === "dark" ? "border-[#4a4d4a]" : "border-[#b9bab4]"}`}>
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="m15.5 15.5 5 5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
            <input value={tocQuery} onChange={(event) => setTocQuery(event.target.value)} placeholder="搜索目录" aria-label="搜索目录" className="book-toc-search min-w-0 flex-1 text-current placeholder:text-muted" />
          </label>
        </div>
        <ol className="m-0 list-none px-4 py-5">{filteredToc.map((item) => <li key={item.id}><button type="button" data-toc-active={activeChapterId === item.targetId ? "true" : undefined} onClick={() => chooseChapter(item.targetId)} style={{ paddingLeft: `${16 + item.depth * 16}px` }} className={`relative block w-full border-0 bg-transparent py-2.5 pr-4 text-left font-serif text-[13px] leading-relaxed cursor-pointer ${activeChapterId === item.targetId ? "font-bold text-red before:absolute before:inset-y-2 before:right-0 before:w-[2px] before:bg-red" : "text-current hover:text-red"}`}>{item.title}</button></li>)}</ol>
        {filteredToc.length === 0 && <p className="px-7 py-10 text-center font-sans text-xs text-muted">没有匹配的目录项</p>}
      </aside>
    </>}

    {settingsOpen && <>
      <button type="button" aria-label="关闭阅读设置" onClick={() => setSettingsOpen(false)} className="fixed inset-0 z-30 border-0 bg-black/10 cursor-default" />
      <section className={`fixed inset-x-4 bottom-4 z-40 border p-5 shadow-[8px_12px_35px_rgba(0,0,0,.14)] md:inset-x-auto md:bottom-auto md:right-20 md:top-1/2 md:w-72 md:-translate-y-1/2 ${panelClass}`} aria-label="阅读设置">
        <div className="mb-5 flex items-center justify-between"><h2 className="m-0 font-sans text-sm">阅读设置</h2><button type="button" onClick={() => setSettingsOpen(false)} className="border-0 bg-transparent text-xl cursor-pointer text-current" aria-label="关闭设置">×</button></div>
        <div className="mb-2 font-sans text-xs text-muted">阅读方式</div>
        <div className="mb-6 grid grid-cols-2 gap-2">{(["paged", "scroll"] as BookReaderMode[]).map((value) => <button type="button" key={value} onClick={() => changeMode(value)} className={`h-10 border bg-transparent text-current cursor-pointer ${mode === value ? "border-red font-bold text-red outline outline-1 outline-red" : "border-rule"}`}>{value === "paged" ? "双页阅读" : "上下滚动"}</button>)}</div>
        <label className="mb-2 flex items-center justify-between font-sans text-xs text-muted"><span>字号</span><span>{fontSize}px</span></label>
        <input type="range" min="14" max="24" value={fontSize} onChange={(event) => setFontSize(+event.target.value)} className="book-reader-range mb-6 w-full" aria-label="字号" />
        <div className="mb-2 font-sans text-xs text-muted">纸张</div>
        <div className="grid grid-cols-3 gap-2">{(["paper", "light", "dark"] as BookReaderTheme[]).map((value) => <button type="button" key={value} onClick={() => setTheme(value)} className={`h-10 border cursor-pointer ${value === "paper" ? "bg-[#fbfaf6] text-ink" : value === "light" ? "bg-white text-ink" : "bg-[#202321] text-white"} ${theme === value ? "border-red outline outline-1 outline-red" : "border-rule"}`}>{value === "paper" ? "纸张" : value === "light" ? "明亮" : "夜间"}</button>)}</div>
      </section>
    </>}

    <header className={`relative z-20 h-12 border-b backdrop-blur-md ${chromeClass}`}>
      <div className="mx-auto flex h-full max-w-[1180px] items-center gap-3 px-4 font-sans text-xs md:px-10">
        <Link to={backHref} className="text-current no-underline" aria-label="返回问答">←</Link>
        <span className="min-w-0 flex-1 truncate text-muted md:hidden">{chapters[activeChapterIndex]?.title || bookTitle}</span>
        <span className="hidden min-w-0 flex-1 truncate text-muted md:block">{bookTitle}</span>
        <span className="hidden max-w-[42%] truncate text-muted md:block">{chapters[activeChapterIndex]?.title}</span>
        <button type="button" onClick={() => setTocOpen(true)} className="border-0 bg-transparent p-0 font-sans text-xs text-current cursor-pointer md:hidden">目录</button>
        <button type="button" onClick={() => setSettingsOpen((value) => !value)} className="border-0 bg-transparent p-0 text-current cursor-pointer md:hidden" aria-label="打开阅读设置"><svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true"><path d="M4 6h7m4 0h5M4 12h3m4 0h9M4 18h9m4 0h3" fill="none" stroke="currentColor" strokeWidth="1.5" /><circle cx="13" cy="6" r="2" fill="none" stroke="currentColor" strokeWidth="1.5" /><circle cx="9" cy="12" r="2" fill="none" stroke="currentColor" strokeWidth="1.5" /><circle cx="15" cy="18" r="2" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg></button>
        {onDownload && <button type="button" onClick={onDownload} className="ml-1 border-0 border-l border-rule bg-transparent py-0 pl-3 pr-0 text-current cursor-pointer md:hidden" aria-label="移动端下载整本 EPUB"><svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 20h14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" /></svg></button>}
        <span className="hidden tabular-nums text-muted md:inline">全书 {bookProgress}%</span>
      </div>
    </header>

    {expandedImage && <div role="dialog" aria-modal="true" aria-label="图片预览" onClick={() => setExpandedImage(undefined)} className="fixed inset-0 z-[70] flex items-center justify-center bg-black/85 p-5 md:p-10">
      <button type="button" onClick={() => setExpandedImage(undefined)} className="absolute right-5 top-5 border border-white/40 bg-black/20 px-3 py-2 font-sans text-xs text-white hover:border-white" aria-label="关闭图片预览">关闭</button>
      <figure className="m-0 flex max-h-full max-w-full flex-col items-center gap-3" onClick={(event) => event.stopPropagation()}>
        <img src={expandedImage.src} alt={expandedImage.alt || "放大图片"} className="max-h-[88vh] max-w-[94vw] cursor-zoom-out object-contain shadow-[0_20px_70px_rgba(0,0,0,.35)]" />
        {expandedImage.alt && expandedImage.alt !== "正文图片" && <figcaption className="font-sans text-xs text-white/75">{expandedImage.alt}</figcaption>}
      </figure>
    </div>}

    {mode === "scroll" ? <div ref={scrollRef} onScroll={updateScrollProgress} onClick={handleReaderClick} className="h-[calc(100%-48px)] overflow-y-auto scroll-smooth">
      <main className="mx-auto max-w-[920px] px-0 py-0 md:px-5 md:py-8">
        <article className={`relative min-h-full border-0 px-6 py-10 shadow-none sm:px-12 md:min-h-[calc(100vh-96px)] md:border-x md:px-20 md:py-20 md:shadow-[0_16px_50px_rgba(32,32,28,.10)] ${pageClass} ${theme === "dark" ? "md:border-[#2d312e]" : "md:border-[#ddddd6]"}`} style={{ fontSize: `${fontSize}px`, lineHeight: 2.05 }}>
          <div className="mx-auto max-w-[730px]">{error && <p className="border-l-4 border-red bg-red/5 px-4 py-3 text-sm text-red">{error}</p>}{children}{chapterNavigation}</div>
        </article>
      </main>
    </div> : <main className="relative h-[calc(100%-48px)] px-0 py-0 md:px-20 md:py-6">
      <div className="relative mx-auto h-full max-w-[1180px]">
        <article className={`relative h-full overflow-hidden border-0 px-6 pb-16 pt-10 shadow-none sm:px-10 md:border md:px-16 md:py-14 md:shadow-[0_16px_55px_rgba(32,32,28,.14)] ${pageClass} ${theme === "dark" ? "md:border-[#2d312e]" : "md:border-[#d8d8d1]"}`}>
          {columnsPerSpread === 2 && <div className={`pointer-events-none absolute inset-y-0 left-1/2 z-10 w-10 -translate-x-1/2 ${theme === "dark" ? "bg-[linear-gradient(90deg,transparent,rgba(0,0,0,.22),transparent)]" : "bg-[linear-gradient(90deg,transparent,rgba(77,75,66,.09),transparent)]"}`} aria-hidden="true" />}
          <div ref={flowRef} data-book-page-flow onClick={handleReaderClick} className={`h-full overflow-hidden [column-fill:auto] [&_img]:cursor-zoom-in [&_figure]:break-inside-avoid [&_h1]:[break-after:avoid-column] [&_h2]:[break-after:avoid-column] [&_li]:break-inside-avoid ${pageTransitioning ? "book-page-content-arrive" : ""}`} style={{ columnCount: columnsPerSpread, columnGap: columnsPerSpread === 2 ? "80px" : "48px", fontSize: `${fontSize}px`, lineHeight: 1.95 }}>
            {error && <p className="border-l-4 border-red bg-red/5 px-4 py-3 text-sm text-red">{error}</p>}{children}
            {trailingBlankPage && <span data-book-trailing-page className="book-page-trailing-blank" aria-hidden="true" />}
          </div>
        </article>
        <button type="button" onClick={previousPage} disabled={pageTransitioning || (!previousChapter && pageMetrics.page === 0)} className={`absolute bottom-4 left-5 z-30 flex h-9 items-center justify-center gap-1 border px-3 font-sans text-xs shadow-[2px_4px_14px_rgba(0,0,0,.08)] cursor-pointer transition-colors disabled:cursor-default disabled:opacity-20 sm:left-8 ${panelClass}`} aria-label="上一页" title="上一页（←）"><span aria-hidden="true">‹</span> 上一页</button>
        <button type="button" onClick={nextPage} disabled={pageTransitioning || (!nextChapter && pageMetrics.page >= pageMetrics.spreads - 1)} className={`absolute bottom-4 right-5 z-30 flex h-9 items-center justify-center gap-1 border px-3 font-sans text-xs shadow-[2px_4px_14px_rgba(0,0,0,.08)] cursor-pointer transition-colors disabled:cursor-default disabled:opacity-20 sm:right-8 ${panelClass}`} aria-label="下一页" title="下一页（→ 或空格）">下一页 <span aria-hidden="true">›</span></button>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-1 flex items-center justify-center gap-4 font-sans text-[10px] text-muted md:bottom-2">
        <span>{firstPhysicalPage === lastPhysicalPage ? firstPhysicalPage : `${firstPhysicalPage}–${lastPhysicalPage}`} / {pageMetrics.physicalPages} 页</span>
      </div>
    </main>}
  </div>;
}
