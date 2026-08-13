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
import type { RagReference, RagSearchHit } from "../types";
import { BookAiPanel } from "./BookAiPanel";
import { BookSearchPanel } from "./BookSearchPanel";
import "./BookReader.css";
import {
  bookshelfContains,
  loadMarks,
  popularExplanations,
  reusableExplanation,
  saveExplanation,
  saveMark,
  setBookshelf,
  type ReaderMark,
  type ReusableExplanation,
} from "../readerData";

export type BookReaderPaperColor = "ivory" | "white" | "dark";
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
  datasetId: string;
  itemId: string;
  characterCount: number;
  logicalChapterCount?: number;
  chapters: BookReaderChapter[];
  toc: BookReaderTocItem[];
  activeChapterId: string;
  chapterKey: string;
  focusAnchorId?: string;
  focusText?: { text: string; token: number };
  contentLoading?: boolean;
  error?: string;
  backHref: string;
  onChapterChange: (chapterId: string) => void;
  onLocate: (chapterId: string, text?: string) => void;
  onSearch: (query: string) => Promise<RagSearchHit[]>;
  onDownload?: () => void;
  children: ReactNode;
}

interface ExpandedImage {
  src: string;
  alt: string;
}

interface ReaderTextSelection {
  text: string;
  range: Range;
  left: number;
  top: number;
  above: boolean;
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

function storedPaperColor(): BookReaderPaperColor {
  const value = window.localStorage.getItem("jojo-reader-paper-color");
  if (value === "ivory" || value === "white" || value === "dark") return value;
  const legacy = window.localStorage.getItem("jojo-reader-theme");
  return legacy === "dark" ? "dark" : legacy === "light" ? "white" : "ivory";
}

function storedPaperTexture(): boolean {
  const value = window.localStorage.getItem("jojo-reader-paper-texture");
  if (value === "true" || value === "false") return value === "true";
  return window.localStorage.getItem("jojo-reader-theme") !== "light";
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
  datasetId,
  itemId,
  characterCount,
  logicalChapterCount,
  chapters,
  toc,
  activeChapterId,
  chapterKey,
  focusAnchorId,
  focusText,
  contentLoading = false,
  error,
  backHref,
  onChapterChange,
  onLocate,
  onSearch,
  onDownload,
  children,
}: BookReaderProps) {
  const [fontSize, setFontSize] = useState(storedFontSize);
  const [paperColor, setPaperColor] = useState<BookReaderPaperColor>(storedPaperColor);
  const [paperTexture, setPaperTexture] = useState(storedPaperTexture);
  const [mode, setMode] = useState<BookReaderMode>(storedMode);
  const [tocOpen, setTocOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [tocQuery, setTocQuery] = useState("");
  const [toolPopover, setToolPopover] = useState<"font" | "color">();
  const [textSelection, setTextSelection] = useState<ReaderTextSelection>();
  const [thoughtOpen, setThoughtOpen] = useState(false);
  const [thought, setThought] = useState("");
  const [aiQuestion, setAiQuestion] = useState<string>();
  const [aiInitialAnswer, setAiInitialAnswer] = useState<string>();
  const [aiExplanationQuote, setAiExplanationQuote] = useState<string>();
  const [marks, setMarks] = useState<ReaderMark[]>([]);
  const [onBookshelf, setOnBookshelf] = useState(false);
  const [readerNotice, setReaderNotice] = useState("");
  const [popular, setPopular] = useState<ReusableExplanation[]>([]);
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
  const jumpTimerRef = useRef<number | undefined>(undefined);

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

  useEffect(() => { window.localStorage.setItem("jojo-reader-paper-color", paperColor); }, [paperColor]);

  useEffect(() => { window.localStorage.setItem("jojo-reader-paper-texture", String(paperTexture)); }, [paperTexture]);

  useEffect(() => {
    window.localStorage.setItem("jojo-reader-mode", mode);
  }, [mode]);

  useEffect(() => () => {
    if (transitionTimerRef.current) window.clearTimeout(transitionTimerRef.current);
    if (jumpTimerRef.current) window.clearTimeout(jumpTimerRef.current);
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
      setSearchOpen(false);
      setAiOpen(false);
      setToolPopover(undefined);
      setTextSelection(undefined);
      setThoughtOpen(false);
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
    let cancelled = false;
    loadMarks(itemId, activeChapterId)
      .then((value) => { if (!cancelled) setMarks(value); })
      .catch(() => { if (!cancelled) setMarks([]); });
    popularExplanations(itemId, activeChapterId)
      .then((value) => { if (!cancelled) setPopular(value); })
      .catch(() => { if (!cancelled) setPopular([]); });
    return () => { cancelled = true; };
  }, [activeChapterId, itemId]);

  useEffect(() => {
    let cancelled = false;
    bookshelfContains(itemId)
      .then((value) => { if (!cancelled) setOnBookshelf(value); })
      .catch(() => { if (!cancelled) setOnBookshelf(false); });
    return () => { cancelled = true; };
  }, [itemId]);

  useEffect(() => {
    const root = mode === "paged" ? flowRef.current : scrollRef.current;
    if (!root || contentLoading || !marks.length) return;
    root.querySelectorAll("mark[data-reader-mark]").forEach((mark) => mark.replaceWith(...mark.childNodes));
    root.normalize();
    for (const saved of marks) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      let match: Text | undefined;
      while (node) {
        const text = node.textContent || "";
        const index = text.indexOf(saved.quote);
        if (index >= 0 && (!saved.prefix || text.slice(Math.max(0, index - saved.prefix.length), index) === saved.prefix) && (!saved.suffix || text.slice(index + saved.quote.length, index + saved.quote.length + saved.suffix.length) === saved.suffix)) {
          if (match) { match = undefined; break; }
          match = node as Text;
        }
        node = walker.nextNode();
      }
      if (!match) continue;
      const index = (match.textContent || "").indexOf(saved.quote);
      const range = document.createRange();
      range.setStart(match, index); range.setEnd(match, index + saved.quote.length);
      const marker = document.createElement("mark");
      marker.dataset.readerMark = saved.id;
      marker.className = saved.kind === "thought" ? "book-reader-thought-anchor" : "book-reader-user-underline";
      if (saved.thought) marker.title = saved.thought;
      range.surroundContents(marker);
    }
  }, [contentLoading, marks, mode, pageMetrics.step]);

  useEffect(() => {
    const root = mode === "paged" ? flowRef.current : scrollRef.current;
    if (!root || contentLoading || !popular.length) return;
    for (const explanation of popular) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const value = node.textContent || "";
        const index = value.indexOf(explanation.quote);
        if (index >= 0) {
          const range = document.createRange();
          range.setStart(node, index); range.setEnd(node, index + explanation.quote.length);
          const marker = document.createElement("mark");
          marker.dataset.readerExplanation = "true";
          marker.title = `${explanation.count} 位读者查询过，点击查看解释`;
          marker.addEventListener("click", () => {
            setAiExplanationQuote(explanation.quote);
            setAiQuestion(undefined);
            setAiInitialAnswer(`${explanation.answer}\n\n已有 ${explanation.count} 位读者查询过这段话。`);
            openPanel("ai");
          });
          range.surroundContents(marker);
          break;
        }
        node = walker.nextNode();
      }
    }
  }, [contentLoading, mode, pageMetrics.step, popular]);

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
  }, [children, contentLoading, fontSize, measurePages, paperColor, paperTexture]);

  const goToPage = useCallback((page: number, behavior: ScrollBehavior = "smooth") => {
    const bounded = Math.max(0, Math.min(page, pageMetrics.spreads - 1));
    flowRef.current?.scrollTo({ left: bounded * pageMetrics.step, behavior });
    currentPageRef.current = bounded;
    setPageMetrics((current) => ({ ...current, page: bounded }));
    setReadingProgress(pageMetrics.spreads <= 1 ? 100 : Math.round((bounded / (pageMetrics.spreads - 1)) * 100));
    setTextSelection(undefined);
    setThoughtOpen(false);
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

  const highlightJumpTarget = useCallback((target: HTMLElement): void => {
    document.querySelectorAll("[data-book-jump-target]").forEach((element) => {
      element.removeAttribute("data-book-jump-target");
    });
    target.setAttribute("data-book-jump-target", "true");
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
    if (jumpTimerRef.current) window.clearTimeout(jumpTimerRef.current);
    jumpTimerRef.current = window.setTimeout(() => target.removeAttribute("data-book-jump-target"), 2200);
  }, []);

  const revealElement = useCallback((target: HTMLElement) => {
    if (mode === "scroll") {
      target.scrollIntoView({ behavior: "auto", block: "center" });
      highlightJumpTarget(target);
      return;
    }
    const flow = flowRef.current;
    if (!flow || !pageMetrics.step) return;
    const targetRect = target.getClientRects()[0] ?? target.getBoundingClientRect();
    const targetLeft = Math.max(0, targetRect.left - flow.getBoundingClientRect().left + flow.scrollLeft);
    goToPage(Math.floor((targetLeft + 1) / pageMetrics.step), "auto");
    highlightJumpTarget(target);
  }, [goToPage, highlightJumpTarget, mode, pageMetrics.step]);

  const revealAnchor = useCallback((anchorId: string) => {
    const target = document.getElementById(anchorId);
    if (target) revealElement(target);
  }, [revealElement]);

  useEffect(() => {
    if (!focusAnchorId || contentLoading) return;
    const timer = window.setTimeout(() => revealAnchor(focusAnchorId), 80);
    return () => window.clearTimeout(timer);
  }, [contentLoading, focusAnchorId, pageMetrics.step, revealAnchor]);

  useEffect(() => {
    if (!focusText?.text || contentLoading) return;
    const timer = window.setTimeout(() => {
      const root = mode === "paged" ? flowRef.current : scrollRef.current;
      if (!root) return;
      root.querySelectorAll("mark[data-book-search-target]").forEach((mark) => mark.replaceWith(...mark.childNodes));
      root.normalize();
      const query = focusText.text.replace(/\s+/g, " ").trim();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const value = node.textContent || "";
        const index = value.indexOf(query);
        if (index >= 0) {
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + query.length);
          const marker = document.createElement("mark");
          marker.setAttribute("data-book-search-target", "true");
          range.surroundContents(marker);
          revealElement(marker);
          return;
        }
        node = walker.nextNode();
      }
      const title = root.querySelector<HTMLElement>("h1,h2,h3");
      if (title) revealElement(title);
    }, 140);
    return () => window.clearTimeout(timer);
  }, [contentLoading, focusText, mode, pageMetrics.step, revealElement]);

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

  function captureTextSelection(): void {
    window.setTimeout(() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) {
        setTextSelection(undefined);
        setThoughtOpen(false);
        return;
      }
      const range = selection.getRangeAt(0);
      const ancestor = range.commonAncestorContainer;
      const insideReader = Boolean(flowRef.current?.contains(ancestor) || scrollRef.current?.contains(ancestor));
      const text = selection.toString().replace(/\s+/g, " ").trim();
      if (!insideReader || !text) return;
      const rect = range.getBoundingClientRect();
      const toolbarHalfWidth = Math.min(128, Math.max(0, window.innerWidth / 2 - 8));
      const above = rect.top > 110;
      setTextSelection({
        text: text.slice(0, 2_000),
        range: range.cloneRange(),
        left: Math.min(window.innerWidth - toolbarHalfWidth, Math.max(toolbarHalfWidth, rect.left + rect.width / 2)),
        top: above ? rect.top - 10 : rect.bottom + 10,
        above,
      });
      setThoughtOpen(false);
    }, 0);
  }

  function wrapSelection(className: string, title?: string): void {
    if (!textSelection) return;
    const marker = document.createElement("mark");
    marker.className = className;
    if (title) marker.title = title;
    try {
      textSelection.range.surroundContents(marker);
    } catch {
      // Multi-paragraph ranges need a persisted anchor model before they can be styled safely.
    }
    window.getSelection()?.removeAllRanges();
    setTextSelection(undefined);
    setThoughtOpen(false);
  }

  async function copySelection(): Promise<void> {
    if (!textSelection) return;
    try {
      await navigator.clipboard.writeText(textSelection.text);
    } catch {
      const input = document.createElement("textarea");
      input.value = textSelection.text;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.append(input);
      input.select();
      document.execCommand?.("copy");
      input.remove();
    }
    window.getSelection()?.removeAllRanges();
    setTextSelection(undefined);
  }

  function selectionAnchor() {
    if (!textSelection) return undefined;
    const container = textSelection.range.startContainer.textContent || "";
    const start = textSelection.range.startOffset;
    return { chapterId: activeChapterId, quote: textSelection.text, prefix: container.slice(Math.max(0, start - 24), start), suffix: container.slice(textSelection.range.endOffset, textSelection.range.endOffset + 24) };
  }

  async function underlineSelection(): Promise<void> {
    const anchor = selectionAnchor();
    if (!anchor) return;
    try {
      const saved = await saveMark({ ...anchor, datasetId, itemId, kind: "underline" });
      setMarks((value) => [...value, saved]);
      wrapSelection("book-reader-user-underline");
    } catch (reason) { setReaderNotice(reason instanceof Error ? reason.message : String(reason)); }
  }

  async function saveThought(): Promise<void> {
    if (!thought.trim()) return;
    const anchor = selectionAnchor();
    if (!anchor) return;
    try {
      const saved = await saveMark({ ...anchor, datasetId, itemId, kind: "thought", thought: thought.trim() });
      setMarks((value) => [...value, saved]);
      wrapSelection("book-reader-thought-anchor", thought.trim());
      setThought("");
    } catch (reason) { setReaderNotice(reason instanceof Error ? reason.message : String(reason)); }
  }

  async function explainSelection(): Promise<void> {
    if (!textSelection) return;
    const quote = textSelection.text;
    setAiExplanationQuote(quote);
    setAiInitialAnswer(undefined);
    try {
      const reusable = await reusableExplanation(itemId, quote);
      if (reusable) {
        setAiQuestion(undefined);
        setAiInitialAnswer(`${reusable.answer}\n\n已有 ${reusable.count} 位读者查询过这段话。`);
      } else {
        await saveExplanation({ datasetId, itemId, chapterId: activeChapterId, quote });
        setAiQuestion(`请结合《${bookTitle}》的上下文解释这段话：\n\n“${quote}”`);
      }
    } catch {
      setAiQuestion(`请结合《${bookTitle}》的上下文解释这段话：\n\n“${quote}”`);
    }
    setTextSelection(undefined);
    setThoughtOpen(false);
    openPanel("ai");
  }

  async function toggleBookshelf(): Promise<void> {
    try {
      await setBookshelf({ datasetId, itemId, title: bookTitle, added: !onBookshelf });
      setOnBookshelf(!onBookshelf);
      setReaderNotice(onBookshelf ? "已从书架移除" : "已加入书架");
    } catch (reason) { setReaderNotice(reason instanceof Error ? reason.message : String(reason)); }
  }

  function openPanel(panel: "toc" | "search" | "ai"): void {
    setTocOpen(panel === "toc");
    setSearchOpen(panel === "search");
    setAiOpen(panel === "ai");
    setToolPopover(undefined);
    setTextSelection(undefined);
    setThoughtOpen(false);
  }

  function openTool(tool: "font" | "color"): void {
    setToolPopover((current) => current === tool ? undefined : tool);
    setTocOpen(false);
    setSearchOpen(false);
    setAiOpen(false);
    setTextSelection(undefined);
    setThoughtOpen(false);
  }

  function locateReference(reference: RagReference): void {
    if (!reference.targetId) return;
    setAiOpen(false);
    onLocate(reference.targetId, reference.excerpt);
  }

  function locateSearchResult(hit: RagSearchHit, matchText: string): void {
    setSearchOpen(false);
    onLocate(hit.targetId, matchText);
  }

  function updateScrollProgress(): void {
    const reader = scrollRef.current;
    if (!reader) return;
    const range = reader.scrollHeight - reader.clientHeight;
    setReadingProgress(range <= 0 ? 100 : Math.min(100, Math.round((reader.scrollTop / range) * 100)));
    setTextSelection(undefined);
    setThoughtOpen(false);
  }

  const isDark = paperColor === "dark";
  const shellClass = isDark ? "bg-[#151716] text-[#deded8]" : paperColor === "white" ? "bg-[#edf0f0] text-ink" : "bg-[#e8e9e4] text-ink";
  const pageClass = isDark ? "bg-[#202321]" : paperColor === "white" ? "bg-white" : "bg-[#fbfaf6]";
  const panelClass = isDark ? "bg-[#242725] text-[#deded8] border-[#393d3a]" : "bg-[#fbfaf6] text-ink border-[#d8d8d1]";
  const chromeClass = isDark ? "border-[#303431] bg-[#151716]/90" : paperColor === "white" ? "border-[#d6d8d3] bg-[#edf0f0]/90" : "border-[#d6d8d3] bg-[#e8e9e4]/90";
  const controlClass = `flex h-11 w-11 shrink-0 items-center justify-center border bg-transparent font-sans text-[10px] leading-none cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-red md:h-12 md:w-12 md:text-xs ${isDark ? "border-[#444844] hover:bg-[#2b2f2c]" : "border-[#d2d3ce] hover:bg-white"}`;
  const firstPhysicalPage = pageMetrics.page * pageMetrics.columnsPerSpread + 1;
  const lastPhysicalPage = Math.min(firstPhysicalPage + pageMetrics.columnsPerSpread - 1, pageMetrics.physicalPages);

  const chapterNavigation = !contentLoading && <nav aria-label="章节导航" className="mt-20 grid grid-cols-2 border-t border-rule pt-8 font-sans text-xs [break-inside:avoid]">
    <button type="button" disabled={!previousChapter} onClick={() => chooseChapter(previousChapter?.id, "end")} className="border-0 bg-transparent py-4 pr-4 text-left text-current cursor-pointer disabled:cursor-default disabled:opacity-30"><span className="mb-1 block text-muted">上一节</span>{previousChapter?.title ?? "已经是第一节"}</button>
    <button type="button" disabled={!nextChapter} onClick={() => chooseChapter(nextChapter?.id)} className="border-0 border-l border-rule bg-transparent py-4 pl-4 text-right text-current cursor-pointer disabled:cursor-default disabled:opacity-30"><span className="mb-1 block text-muted">下一节</span>{nextChapter?.title ?? "已经是最后一节"}</button>
  </nav>;

  return <div className={`h-screen overflow-hidden ${isDark ? "book-reader-dark" : ""} ${shellClass}`}>
    <nav data-book-toolbar aria-label="阅读工具" className={`fixed bottom-2 left-2 right-2 z-30 flex gap-1 overflow-x-auto border p-1 backdrop-blur-md md:bottom-auto md:left-auto md:right-5 md:top-1/2 md:-translate-y-1/2 md:flex-col md:gap-2 md:overflow-visible md:border-0 md:p-0 ${chromeClass}`}>
      <button type="button" onClick={() => openPanel("toc")} className={controlClass} aria-label="打开目录" title="目录">目录</button>
      <button type="button" onClick={() => openPanel("search")} className={controlClass} aria-label="搜索全书" title="搜索全书">搜索</button>
      <button type="button" onClick={() => { setAiQuestion(undefined); setAiInitialAnswer(undefined); setAiExplanationQuote(undefined); openPanel("ai"); }} className={controlClass} aria-label="打开书内 AI" title="书内 AI">AI</button>
      <button type="button" aria-pressed={onBookshelf} onClick={() => void toggleBookshelf()} className={`${controlClass} ${onBookshelf ? "text-red" : ""}`} aria-label={onBookshelf ? "移出书架" : "加入书架"} title={onBookshelf ? "移出书架" : "加入书架"}>书架</button>
      <button type="button" onClick={() => openTool("font")} className={controlClass} aria-label="调整字号" title="字号">字号</button>
      <button type="button" onClick={() => openTool("color")} className={controlClass} aria-label="选择纸张颜色" title="纸张颜色"><span className={`h-4 w-4 border ${isDark ? "border-white/50 bg-[#202321]" : paperColor === "white" ? "border-[#aaa] bg-white" : "border-[#b8ad96] bg-[#fbfaf6]"}`} aria-hidden="true" /></button>
      <button type="button" aria-pressed={paperTexture} onClick={() => setPaperTexture((value) => !value)} className={`${controlClass} ${paperTexture ? "text-red" : ""}`} aria-label="切换纸张纹理" title={paperTexture ? "关闭纸张纹理" : "开启纸张纹理"}>纹理</button>
      <button type="button" data-reader-mode={mode} onClick={() => changeMode(mode === "paged" ? "scroll" : "paged")} className={controlClass} aria-label="切换阅读模式" title={mode === "paged" ? "切换为上下滚动" : "切换为双页阅读"}>{mode === "paged" ? "双页" : "滚动"}</button>
      {onDownload && <button type="button" onClick={onDownload} className={`${controlClass} md:mt-3`} aria-label="下载整本 EPUB" title="下载整本 EPUB"><svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 20h14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" /></svg></button>}
    </nav>

    {tocOpen && <>
      <button type="button" aria-label="关闭目录" onClick={() => setTocOpen(false)} className="fixed inset-0 z-40 border-0 bg-black/20 cursor-default" />
      <aside ref={tocPanelRef} aria-label="目录面板" className={`fixed inset-y-0 right-0 z-50 w-full overflow-y-auto border-l shadow-[-18px_0_50px_rgba(0,0,0,.12)] sm:w-[min(88vw,420px)] ${panelClass}`}>
        <div className={`sticky top-0 z-10 border-b px-7 py-6 ${panelClass}`}>
          <div className="flex items-start justify-between gap-4">
            <div><p className="m-0 font-sans text-[11px] tracking-[.22em] text-muted">目录</p><h2 className="mb-1 mt-2 text-xl leading-snug">{bookTitle}</h2><p className="m-0 font-sans text-xs text-muted">{logicalChapterCount ? `${logicalChapterCount} 章 · ` : ""}{characterCount.toLocaleString()} 字</p></div>
            <button type="button" onClick={() => setTocOpen(false)} className="border-0 bg-transparent text-2xl cursor-pointer text-current" aria-label="关闭目录">×</button>
          </div>
          <label className={`book-toc-search-shell mt-5 flex h-10 items-center gap-3 border-0 border-b px-0 font-sans text-xs ${isDark ? "border-[#4a4d4a]" : "border-[#b9bab4]"}`}>
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="m15.5 15.5 5 5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
            <input value={tocQuery} onChange={(event) => setTocQuery(event.target.value)} placeholder="搜索目录" aria-label="搜索目录" className="book-toc-search min-w-0 flex-1 text-current placeholder:text-muted" />
          </label>
        </div>
        <ol className="m-0 list-none px-4 py-5">{filteredToc.map((item) => <li key={item.id}><button type="button" data-toc-active={activeChapterId === item.targetId ? "true" : undefined} onClick={() => chooseChapter(item.targetId)} style={{ paddingLeft: `${16 + item.depth * 16}px` }} className={`relative block w-full border-0 bg-transparent py-2.5 pr-4 text-left font-serif text-[13px] leading-relaxed cursor-pointer ${activeChapterId === item.targetId ? "font-bold text-red before:absolute before:inset-y-2 before:right-0 before:w-[2px] before:bg-red" : "text-current hover:text-red"}`}>{item.title}</button></li>)}</ol>
        {filteredToc.length === 0 && <p className="px-7 py-10 text-center font-sans text-xs text-muted">没有匹配的目录项</p>}
      </aside>
    </>}

    {searchOpen && <><button type="button" aria-label="关闭全书搜索" onClick={() => setSearchOpen(false)} className="fixed inset-0 z-40 border-0 bg-black/20 cursor-default" /><BookSearchPanel bookTitle={bookTitle} panelClass={panelClass} onClose={() => setSearchOpen(false)} onJump={locateSearchResult} onSearch={onSearch} /></>}

    {aiOpen && <><button type="button" aria-label="关闭书内 AI" onClick={() => setAiOpen(false)} className="fixed inset-0 z-40 border-0 bg-black/20 cursor-default" /><BookAiPanel key={`${aiQuestion || "book-ai"}:${aiInitialAnswer || ""}`} bookTitle={bookTitle} datasetId={datasetId} itemId={itemId} initialQuestion={aiQuestion} initialAnswer={aiInitialAnswer} explanationQuote={aiExplanationQuote} panelClass={panelClass} onClose={() => setAiOpen(false)} onJump={locateReference} onExplanationComplete={(quote, answer) => void saveExplanation({ datasetId, itemId, chapterId: activeChapterId, quote, answer })} /></>}

    {toolPopover && <>
      <button type="button" aria-label="关闭阅读工具" onClick={() => setToolPopover(undefined)} className="fixed inset-0 z-20 border-0 bg-transparent cursor-default" />
      <section className={`fixed bottom-16 left-2 right-2 z-40 border p-4 shadow-[6px_10px_30px_rgba(0,0,0,.14)] md:bottom-auto md:left-auto md:right-20 md:top-1/2 md:w-64 md:-translate-y-1/2 ${panelClass}`} aria-label={toolPopover === "font" ? "字号工具" : "纸张颜色工具"}>
        {toolPopover === "font" ? <>
          <label className="mb-3 flex items-center justify-between font-sans text-xs text-muted"><span>字号</span><span>{fontSize}px</span></label>
          <input type="range" min="14" max="24" value={fontSize} onChange={(event) => setFontSize(+event.target.value)} className="book-reader-range w-full" aria-label="字号" />
        </> : <>
          <p className="mb-3 mt-0 font-sans text-xs text-muted">纸张颜色</p>
          <div className="grid grid-cols-3 gap-2">{(["ivory", "white", "dark"] as BookReaderPaperColor[]).map((value) => <button type="button" key={value} onClick={() => { setPaperColor(value); setToolPopover(undefined); }} className={`h-12 border cursor-pointer ${value === "ivory" ? "bg-[#fbfaf6] text-ink" : value === "white" ? "bg-white text-ink" : "bg-[#202321] text-white"} ${paperColor === value ? "border-red outline outline-1 outline-red" : "border-rule"}`}>{value === "ivory" ? "米白" : value === "white" ? "白色" : "夜间"}</button>)}</div>
        </>}
      </section>
    </>}

    {textSelection && <div className={`book-selection-tools fixed z-[65] -translate-x-1/2 font-sans ${textSelection.above ? "-translate-y-full" : ""}`} style={{ left: textSelection.left, top: textSelection.top }}>
      <div className={`flex border shadow-[3px_6px_20px_rgba(0,0,0,.18)] ${panelClass}`} role="toolbar" aria-label="选中文字工具">
        <button type="button" onClick={() => void copySelection()} className="book-selection-action">复制</button>
        <button type="button" onClick={() => void underlineSelection()} className="book-selection-action">划线</button>
        <button type="button" onClick={() => setThoughtOpen((value) => !value)} className="book-selection-action">写想法</button>
        <button type="button" onClick={() => void explainSelection()} className="book-selection-action text-red">AI 解释</button>
      </div>
      {thoughtOpen && <div className={`mt-1 w-72 border p-3 shadow-[3px_6px_20px_rgba(0,0,0,.16)] ${panelClass}`}>
        <textarea autoFocus value={thought} onChange={(event) => setThought(event.target.value)} placeholder="写下此刻的想法……" rows={3} className="book-thought-input block w-full resize-none border-0 border-b border-rule bg-transparent px-0 py-1 font-serif text-sm leading-6 text-current" />
        <div className="mt-2 flex justify-end"><button type="button" disabled={!thought.trim()} onClick={() => void saveThought()} className="border-0 bg-transparent p-0 text-xs font-bold text-red cursor-pointer disabled:opacity-30">保存</button></div>
      </div>}
    </div>}

    {readerNotice && <button type="button" onClick={() => setReaderNotice("")} className={`fixed bottom-20 left-1/2 z-[66] -translate-x-1/2 border px-4 py-2 font-sans text-xs shadow-lg md:bottom-6 ${panelClass}`}>{readerNotice}</button>}

    <header className={`relative z-20 h-12 border-b backdrop-blur-md ${chromeClass}`}>
      <div className="mx-auto flex h-full max-w-[1180px] items-center gap-3 px-4 font-sans text-xs md:px-10">
        <Link to={backHref} className="text-current no-underline" aria-label="返回问答">←</Link>
        <span className="min-w-0 flex-1 truncate text-muted md:hidden">{chapters[activeChapterIndex]?.title || bookTitle}</span>
        <span className="hidden min-w-0 flex-1 truncate text-muted md:block">{bookTitle}</span>
        <span className="hidden max-w-[42%] truncate text-muted md:block">{chapters[activeChapterIndex]?.title}</span>
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

    {mode === "scroll" ? <div ref={scrollRef} onScroll={updateScrollProgress} onClick={handleReaderClick} onMouseUp={captureTextSelection} className="h-[calc(100%-48px)] overflow-y-auto">
      <main className="mx-auto max-w-[920px] px-0 py-0 md:px-5 md:py-8">
        <article className={`relative min-h-full border-0 px-6 pb-24 pt-10 shadow-none sm:px-12 md:min-h-[calc(100vh-96px)] md:border-x md:px-20 md:py-20 md:shadow-[0_16px_50px_rgba(32,32,28,.10)] ${pageClass} ${paperTexture ? "book-page-texture" : ""} ${isDark ? "md:border-[#2d312e]" : "md:border-[#ddddd6]"}`} style={{ fontSize: `${fontSize}px`, lineHeight: 2.05 }}>
          <div className="mx-auto max-w-[730px]">{error && <p className="border-l-4 border-red bg-red/5 px-4 py-3 text-sm text-red">{error}</p>}{children}{chapterNavigation}</div>
        </article>
      </main>
    </div> : <main className="relative h-[calc(100%-48px)] px-0 py-0 md:px-20 md:py-6">
      <div className="relative mx-auto h-full max-w-[1180px]">
        <article className={`relative h-full overflow-hidden border-0 px-6 pb-20 pt-10 shadow-none sm:px-10 md:border md:px-16 md:py-14 md:shadow-[0_16px_55px_rgba(32,32,28,.14)] ${pageClass} ${paperTexture ? "book-page-texture" : ""} ${isDark ? "md:border-[#2d312e]" : "md:border-[#d8d8d1]"}`}>
          {columnsPerSpread === 2 && <div className={`pointer-events-none absolute inset-y-0 left-1/2 z-10 w-10 -translate-x-1/2 ${isDark ? "bg-[linear-gradient(90deg,transparent,rgba(0,0,0,.22),transparent)]" : "bg-[linear-gradient(90deg,transparent,rgba(77,75,66,.09),transparent)]"}`} aria-hidden="true" />}
          <div ref={flowRef} data-book-page-flow onClick={handleReaderClick} onMouseUp={captureTextSelection} className={`relative h-full overflow-hidden [column-fill:auto] [&_img]:cursor-zoom-in [&_figure]:break-inside-avoid [&_h1]:[break-after:avoid-column] [&_h2]:[break-after:avoid-column] [&_li]:break-inside-avoid ${pageTransitioning ? "book-page-content-arrive" : ""}`} style={{ columnCount: columnsPerSpread, columnGap: columnsPerSpread === 2 ? "80px" : "48px", fontSize: `${fontSize}px`, lineHeight: 1.95 }}>
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
