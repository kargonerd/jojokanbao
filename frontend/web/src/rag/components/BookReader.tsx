import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { IoCopyOutline, IoCreateOutline, IoSparklesOutline } from "react-icons/io5";
import type { ReaderSelectionRect } from "@jojo/ui/reader-selection";
import { AnnotationDiscussionPanel } from "../../annotations/AnnotationDiscussionPanel";
import {
  clearReaderExplanationMarks,
  renderAnnotationMarks,
  renderReaderExplanationMarks,
  textAnchorFromRange,
} from "../../annotations/domAnchors";
import type { AnnotationVisibility, TextAnchor } from "../../annotations/types";
import { useAnnotationThreads } from "../../annotations/useAnnotationThreads";
import { useFeatureFlag } from "../../featureFlags";
import { useAccountSessionStore } from "../../account/session";
import { useRecentReadingStore } from "../../library/recentReadingStore";
import { ReadingBookshelfContext } from "../../reading/ReadingBookshelfContext";
import type { RagAnswerMetadata, RagFocusContext, RagReference, RagSearchHit } from "../types";
import { BookAiPanel } from "./BookAiPanel";
import { BookSearchPanel } from "./BookSearchPanel";
import { BookNavigationSheet } from "./BookNavigationSheet";
import { BookSelectionPopover } from "./BookSelectionPopover";
import { BookThoughtComposer } from "./BookThoughtComposer";
import "./BookReader.css";
import {
  bookshelfContains,
  popularExplanations,
  reusableExplanation,
  saveExplanation,
  setBookshelf,
  type ReusableExplanation,
} from "../readerData";

export type BookReaderPaperColor = "ivory" | "white" | "dark";
export type BookReaderMode = "paged" | "scroll";
type ReaderToolPopover = "font" | "color" | "display" | "progress";
type ReaderToolIconName = "toc" | "search" | "ai" | "progress" | "display";

function ReaderToolIcon({ name }: { name: ReaderToolIconName }) {
  if (name === "ai") {
    return <span className="relative font-serif text-[17px] font-bold leading-none" aria-hidden="true">AI<span className="absolute -right-2 -top-2 text-[9px] text-red">✦</span></span>;
  }
  if (name === "display") {
    return <span className="font-serif text-[22px] font-semibold leading-none" aria-hidden="true">A</span>;
  }
  if (name === "toc") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h2M4 12h2M4 18h2M9 6h11M9 12h11M9 18h11" /></svg>;
  }
  if (name === "search") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" /></svg>;
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h18" /><rect x="9" y="8" width="6" height="8" /></svg>;
}

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
  itemKey: string;
  manifestObject: string;
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
  onInternalLink?: (chapterId: string, anchorId?: string) => void;
  onSearch: (query: string) => Promise<RagSearchHit[]>;
  onDownload?: () => void;
  speechControl?: ReactNode;
  children: ReactNode;
}

interface ExpandedImage {
  src: string;
  alt: string;
}

interface ReaderTextSelection {
  text: string;
  anchor: TextAnchor;
  rect: ReaderSelectionRect;
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
  itemKey,
  manifestObject,
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
  onInternalLink,
  onSearch,
  onDownload,
  speechControl,
  children,
}: BookReaderProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const annotationsEnabled = useFeatureFlag("reader.annotations");
  const speechEnabled = useFeatureFlag("reader.speech");
  const rememberRecentReading = useRecentReadingStore((state) => state.remember);
  const currentUserId = useAccountSessionStore((state) => state.userId);
  const bookshelfEnabled = useFeatureFlag("library.bookshelf");
  const agentAccess = Boolean(currentUserId);
  const activeChapterTitle = chapters.find((chapter) => chapter.id === activeChapterId)?.title;
  const [fontSize, setFontSize] = useState(storedFontSize);
  const [paperColor, setPaperColor] = useState<BookReaderPaperColor>(storedPaperColor);
  const [paperTexture, setPaperTexture] = useState(storedPaperTexture);
  const [mode, setMode] = useState<BookReaderMode>(storedMode);
  const [tocOpen, setTocOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [tocQuery, setTocQuery] = useState("");
  const [toolPopover, setToolPopover] = useState<ReaderToolPopover>();
  const [textSelection, setTextSelection] = useState<ReaderTextSelection>();
  const [thoughtSelection, setThoughtSelection] = useState<ReaderTextSelection>();
  const [thought, setThought] = useState("");
  const [thoughtError, setThoughtError] = useState("");
  const [thoughtVisibility, setThoughtVisibility] = useState<AnnotationVisibility>("public");
  const [aiQuestion, setAiQuestion] = useState<string>();
  const [aiInitialAnswer, setAiInitialAnswer] = useState<string>();
  const [aiInitialReferences, setAiInitialReferences] = useState<RagReference[]>();
  const [aiPreparing, setAiPreparing] = useState(false);
  const [aiExplanationQuote, setAiExplanationQuote] = useState<string>();
  const [aiFocus, setAiFocus] = useState<RagFocusContext>();
  const [activeAnnotationId, setActiveAnnotationId] = useState<string>();
  const [annotationSaving, setAnnotationSaving] = useState(false);
  const [onBookshelf, setOnBookshelf] = useState(false);
  const [bookshelfBusy, setBookshelfBusy] = useState(false);
  const [readerNotice, setReaderNotice] = useState("");
  const [popular, setPopular] = useState<ReusableExplanation[]>([]);
  const [expandedImage, setExpandedImage] = useState<ExpandedImage>();
  const [readingProgress, setReadingProgress] = useState(0);
  const [columnsPerSpread, setColumnsPerSpread] = useState(() => window.innerWidth >= 900 ? 2 : 1);
  const [mobileViewport, setMobileViewport] = useState(() => window.innerWidth < 768);
  const [chromeHidden, setChromeHidden] = useState(false);
  const mobileChromeHidden = mobileViewport && chromeHidden;
  const chromeProps = { "data-reader-chrome": true, "aria-hidden": mobileChromeHidden || undefined, inert: mobileChromeHidden };
  const readerTapRef = useRef<{ x: number; y: number; started: number; cancelled: boolean } | null>(null);
  const [speechLauncherTarget, setSpeechLauncherTarget] = useState<HTMLDivElement | null>(null);
  const [pageMetrics, setPageMetrics] = useState<PageMetrics>(DEFAULT_PAGE_METRICS);
  const [trailingBlankPage, setTrailingBlankPage] = useState(false);
  const [pageTransitioning, setPageTransitioning] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<HTMLDivElement>(null);
  const tocPanelRef = useRef<HTMLDivElement>(null);
  const currentPageRef = useRef(0);
  const pendingPageRef = useRef<"start" | "end" | null>("start");
  const transitionTimerRef = useRef<number | undefined>(undefined);
  const jumpTimerRef = useRef<number | undefined>(undefined);
  const aiPreparationRef = useRef(0);

  const activeChapterIndex = Math.max(0, chapters.findIndex((chapter) => chapter.id === activeChapterId));
  const annotationSubject = useMemo(() => ({
    contentType: "book" as const,
    contentId: `${datasetId}:${itemId}`,
    sectionId: activeChapterId,
    contentTitle: `${bookTitle} · ${chapters[activeChapterIndex]?.title || "正文"}`,
    contentUrl: `${window.location.pathname}?${new URLSearchParams({ chapter: activeChapterId })}`,
  }), [activeChapterId, activeChapterIndex, bookTitle, chapters, datasetId, itemId]);
  const annotationAccess = annotationsEnabled && Boolean(currentUserId);
  const annotations = useAnnotationThreads(annotationSubject, annotationAccess, currentUserId);
  const activeAnnotation = annotations.threads.find((thread) => thread.id === activeAnnotationId);
  const readerOverlayOpen = aiOpen || tocOpen || searchOpen || Boolean(toolPopover || thoughtSelection || activeAnnotation || expandedImage);
  const previousChapter = chapters[activeChapterIndex - 1];
  const nextChapter = chapters[activeChapterIndex + 1];
  const bookProgress = chapters.length
    ? Math.min(100, Math.round(((activeChapterIndex + readingProgress / 100) / chapters.length) * 100))
    : 0;

  useEffect(() => {
    if (contentLoading || !activeChapterId) return;
    const query = new URLSearchParams({ chapter: activeChapterId });
    const returnTo = new URLSearchParams(window.location.search).get("returnTo");
    if (returnTo) query.set("returnTo", returnTo);
    rememberRecentReading({
      id: `book:${datasetId}:${itemKey}`,
      kind: "book",
      datasetId,
      itemKey,
      title: bookTitle,
      subtitle: activeChapterTitle || "正文",
      href: `/book/${encodeURIComponent(datasetId)}/${encodeURIComponent(itemKey)}?${query}`,
      progress: bookProgress,
    });
  }, [activeChapterId, activeChapterTitle, bookProgress, bookTitle, contentLoading, datasetId, itemKey, rememberRecentReading]);

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("discussion");
    if (requested && annotations.threads.some((thread) => thread.id === requested)) setActiveAnnotationId(requested);
  }, [annotations.threads]);
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
      setThoughtSelection(undefined);
      setExpandedImage(undefined);
      setChromeHidden(false);
    };
    window.addEventListener("keydown", closePanels);
    return () => window.removeEventListener("keydown", closePanels);
  }, []);

  useEffect(() => {
    const updateViewport = (): void => {
      setColumnsPerSpread(window.innerWidth >= 900 ? 2 : 1);
      setMobileViewport(window.innerWidth < 768);
      if (window.innerWidth >= 768) setChromeHidden(false);
    };
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    flowRef.current?.scrollTo({ left: 0 });
    currentPageRef.current = 0;
    if (pendingPageRef.current === null) pendingPageRef.current = "start";
    setReadingProgress(0);
    setPageMetrics((current) => ({ ...current, page: 0 }));
    setExpandedImage(undefined);
    setTextSelection(undefined);
    setThoughtSelection(undefined);
  }, [chapterKey]);

  useEffect(() => {
    if (!agentAccess) {
      setPopular([]);
      return;
    }
    let cancelled = false;
    popularExplanations(datasetId, itemId, activeChapterId)
      .then((value) => { if (!cancelled) setPopular(value); })
      .catch(() => { if (!cancelled) setPopular([]); });
    return () => { cancelled = true; };
  }, [activeChapterId, agentAccess, datasetId, itemId]);

  useEffect(() => {
    if (!bookshelfEnabled) {
      setOnBookshelf(false);
      return;
    }
    let cancelled = false;
    bookshelfContains(datasetId, itemId)
      .then((value) => { if (!cancelled) setOnBookshelf(value); })
      .catch(() => { if (!cancelled) setOnBookshelf(false); });
    return () => { cancelled = true; };
  }, [bookshelfEnabled, datasetId, itemId]);

  useEffect(() => {
    const root = mode === "paged" ? flowRef.current : scrollRef.current;
    if (!root || contentLoading) return;
    renderAnnotationMarks(root, annotations.threads, setActiveAnnotationId);
  }, [annotations.threads, contentLoading, mode, pageMetrics.step]);

  useEffect(() => {
    const root = mode === "paged" ? flowRef.current : scrollRef.current;
    if (!root || contentLoading) return;
    renderReaderExplanationMarks(root, popular.map((explanation) => ({
      quote: explanation.quote,
      prefix: explanation.prefix ?? "",
      suffix: explanation.suffix ?? "",
      startOffset: null,
      endOffset: null,
      count: explanation.count,
    })), (anchor) => {
      const explanation = popular.find((candidate) => (
        candidate.quote === anchor.quote
        && (candidate.prefix ?? "") === anchor.prefix
        && (candidate.suffix ?? "") === anchor.suffix
      ));
      if (!explanation) return;
      setAiExplanationQuote(explanation.quote);
      setAiQuestion(undefined);
      setAiInitialAnswer(explanation.answer);
      setAiInitialReferences(explanation.references);
      setAiFocus({
        chapterId: activeChapterId,
        ...(activeChapterTitle ? { chapterTitle: activeChapterTitle } : {}),
        quote: explanation.quote,
        ...(explanation.prefix ? { prefix: explanation.prefix } : {}),
        ...(explanation.suffix ? { suffix: explanation.suffix } : {}),
      });
      openPanel("ai");
    });
    return () => clearReaderExplanationMarks(root);
  }, [activeChapterId, activeChapterTitle, contentLoading, mode, pageMetrics.step, popular]);

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
    setThoughtSelection(undefined);
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
      const anchorTarget = focusAnchorId ? document.getElementById(focusAnchorId) : null;
      if (anchorTarget) return;
      const title = root.querySelector<HTMLElement>("h1,h2,h3");
      if (title) revealElement(title);
    }, 140);
    return () => window.clearTimeout(timer);
  }, [contentLoading, focusAnchorId, focusText, mode, pageMetrics.step, revealElement]);

  function startReaderTap(event: ReactPointerEvent<HTMLDivElement>): void {
    if (!mobileViewport) return;
    if (event.isPrimary === false) {
      cancelReaderTap();
      return;
    }
    readerTapRef.current = {
      x: event.clientX, y: event.clientY, started: Date.now(),
      cancelled: Boolean(window.getSelection()?.toString()),
    };
  }

  function moveReaderTap(event: ReactPointerEvent<HTMLDivElement>): void {
    const tap = readerTapRef.current;
    if (tap && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 10) tap.cancelled = true;
  }

  function cancelReaderTap(): void {
    if (readerTapRef.current) readerTapRef.current.cancelled = true;
  }

  function handleReaderClick(event: ReactMouseEvent<HTMLDivElement>): void {
    const tap = readerTapRef.current;
    readerTapRef.current = null;
    if (mobileViewport && (tap?.cancelled || (tap && Date.now() - tap.started > 450))) return;
    const image = (event.target as Element).closest<HTMLImageElement>("img");
    if (image) {
      event.preventDefault();
      setExpandedImage({ src: image.currentSrc || image.src, alt: image.alt });
      return;
    }
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#"]');
    if (!link) {
      if (mobileViewport && event.detail < 2 && !window.getSelection()?.toString()
        && !(event.target as Element).closest("a,button,input,textarea,select,label,[role='button'],[contenteditable='true']")
        && !tocOpen && !searchOpen && !aiOpen && !toolPopover && !textSelection && !expandedImage) {
        setChromeHidden((hidden) => !hidden);
      }
      return;
    }
    const targetId = link.dataset.targetId;
    const anchorId = link.dataset.anchorId
      || decodeURIComponent(link.getAttribute("href")?.slice(1) || "");
    if (targetId && targetId !== activeChapterId) {
      event.preventDefault();
      onInternalLink?.(targetId, anchorId || undefined);
      return;
    }
    if (!anchorId || !document.getElementById(anchorId)) return;
    event.preventDefault();
    revealAnchor(anchorId);
  }

  const captureTextSelection = useCallback((): void => {
    if (readerOverlayOpen) return;
    if (document.activeElement?.closest(".book-selection-tools")) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) {
      setTextSelection(undefined);
      return;
    }
    const range = selection.getRangeAt(0);
    const ancestor = range.commonAncestorContainer;
    const insideReader = Boolean(flowRef.current?.contains(ancestor) || scrollRef.current?.contains(ancestor));
    const root = mode === "paged" ? flowRef.current : scrollRef.current;
    const anchor = root && textAnchorFromRange(root, range, 1_200);
    if (!insideReader || !anchor) return;
    const rect = range.getBoundingClientRect();
    setTextSelection({
      text: anchor.quote,
      anchor,
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
    });
  }, [mode, readerOverlayOpen]);

  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || !(flowRef.current?.contains(event.target) || scrollRef.current?.contains(event.target))) return;
      event.preventDefault();
      captureTextSelection();
    };
    document.addEventListener("selectionchange", captureTextSelection);
    document.addEventListener("contextmenu", onContextMenu);
    const reposition = () => {
      const selection = window.getSelection();
      if (!selection?.rangeCount || selection.isCollapsed) return;
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      setTextSelection((current) => current ? { ...current, rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } } : undefined);
    };
    document.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      document.removeEventListener("selectionchange", captureTextSelection);
      document.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [captureTextSelection]);

  function capturePointerTextSelection(): void {
    window.setTimeout(captureTextSelection, 0);
  }

  function clearSelection(): void {
    window.getSelection()?.removeAllRanges();
    setTextSelection(undefined);
    setThoughtSelection(undefined);
  }

  function composeThought(): void {
    if (!textSelection) return;
    setThoughtSelection(textSelection);
    setThought("");
    setThoughtError("");
    setThoughtVisibility("public");
    setTextSelection(undefined);
    window.getSelection()?.removeAllRanges();
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
    return textSelection?.anchor;
  }

  async function underlineSelection(): Promise<void> {
    if (!annotationsEnabled || annotationSaving) return;
    const anchor = selectionAnchor();
    if (!anchor) return;
    setAnnotationSaving(true);
    try {
      await annotations.create(anchor);
      clearSelection();
      setReaderNotice("已划线");
    } catch (reason) { setReaderNotice(reason instanceof Error ? reason.message : String(reason)); }
    finally { setAnnotationSaving(false); }
  }

  async function saveThought(): Promise<void> {
    if (!annotationAccess || !thought.trim() || annotationSaving) return;
    const anchor = thoughtSelection?.anchor;
    if (!anchor) return;
    setAnnotationSaving(true);
    setThoughtError("");
    try {
      const saved = await annotations.create(anchor, thought.trim(), thoughtVisibility);
      clearSelection();
      setActiveAnnotationId(saved.id);
      setThought("");
      setThoughtVisibility("public");
    } catch (reason) { setThoughtError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setAnnotationSaving(false); }
  }

  async function explainSelection(): Promise<void> {
    if (!textSelection) return;
    const preparationId = ++aiPreparationRef.current;
    const quote = textSelection.text;
    setAiFocus({
      chapterId: activeChapterId,
      ...(activeChapterTitle ? { chapterTitle: activeChapterTitle } : {}),
      quote,
      prefix: textSelection.anchor.prefix,
      suffix: textSelection.anchor.suffix,
    });
    setAiExplanationQuote(quote);
    setAiQuestion(undefined);
    setAiInitialAnswer(undefined);
    setAiInitialReferences(undefined);
    const question = `请结合《${bookTitle}》的上下文解释这段话：\n\n“${quote}”`;
    setTextSelection(undefined);
    setThoughtSelection(undefined);
    setAiPreparing(quote.length <= 2_000);
    openPanel("ai");
    if (quote.length > 2_000) {
      setAiQuestion(question);
      return;
    }
    try {
      const reusable = await reusableExplanation(datasetId, itemId, activeChapterId, quote, {
        prefix: textSelection.anchor.prefix,
        suffix: textSelection.anchor.suffix,
      });
      if (preparationId !== aiPreparationRef.current) return;
      if (reusable) {
        setAiQuestion(undefined);
        setAiInitialAnswer(reusable.answer);
        setAiInitialReferences(reusable.references);
      } else {
        setAiQuestion(question);
      }
    } catch {
      if (preparationId !== aiPreparationRef.current) return;
      setAiQuestion(question);
    } finally {
      if (preparationId === aiPreparationRef.current) setAiPreparing(false);
    }
  }

  function closeAiPanel(): void {
    aiPreparationRef.current += 1;
    setAiPreparing(false);
    setAiOpen(false);
  }

  async function toggleBookshelf(): Promise<void> {
    if (!bookshelfEnabled || bookshelfBusy) return;
    const nextValue = !onBookshelf;
    setBookshelfBusy(true);
    try {
      await setBookshelf({ datasetId, itemId, title: bookTitle, added: nextValue });
      setOnBookshelf(nextValue);
      setReaderNotice(nextValue ? "已加入书架" : "已从书架移除");
    } catch (reason) {
      setReaderNotice(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBookshelfBusy(false);
    }
  }

  function openPanel(panel: "toc" | "search" | "ai"): void {
    setTocOpen(panel === "toc");
    setSearchOpen(panel === "search");
    setAiOpen(panel === "ai");
    setToolPopover(undefined);
    setTextSelection(undefined);
    setThoughtSelection(undefined);
  }

  function openTool(tool: ReaderToolPopover): void {
    setToolPopover((current) => current === tool ? undefined : tool);
    setTocOpen(false);
    setSearchOpen(false);
    setAiOpen(false);
    setTextSelection(undefined);
    setThoughtSelection(undefined);
  }

  function locateSearchResult(hit: RagSearchHit, matchText: string): void {
    setSearchOpen(false);
    onLocate(hit.targetId, matchText);
  }

  function updateScrollProgress(): void {
    cancelReaderTap();
    const reader = scrollRef.current;
    if (!reader) return;
    const range = reader.scrollHeight - reader.clientHeight;
    setReadingProgress(range <= 0 ? 100 : Math.min(100, Math.round((reader.scrollTop / range) * 100)));
    setTextSelection(undefined);
  }

  function openBookAi(): void {
    if (!agentAccess) {
      const returnTo = `${location.pathname}${location.search}${location.hash}`;
      navigate(`/account?returnTo=${encodeURIComponent(returnTo)}`);
      return;
    }
    aiPreparationRef.current += 1;
    setAiPreparing(false);
    setAiQuestion(undefined);
    setAiInitialAnswer(undefined);
    setAiInitialReferences(undefined);
    setAiExplanationQuote(undefined);
    setAiFocus(undefined);
    openPanel("ai");
  }

  function seekReadingProgress(progress: number): void {
    const bounded = Math.max(0, Math.min(100, progress));
    if (mode === "paged") {
      const targetPage = Math.round((bounded / 100) * Math.max(0, pageMetrics.spreads - 1));
      goToPage(targetPage, "auto");
      return;
    }
    const reader = scrollRef.current;
    if (!reader) return;
    const range = Math.max(0, reader.scrollHeight - reader.clientHeight);
    reader.scrollTo({ top: (bounded / 100) * range, behavior: "auto" });
    setReadingProgress(bounded);
  }

  const isDark = paperColor === "dark";
  const shellClass = isDark ? "bg-[#151716] text-[#deded8]" : paperColor === "white" ? "bg-[#edf0f0] text-ink" : "bg-[#e8e9e4] text-ink";
  const pageClass = isDark ? "bg-[#202321]" : paperColor === "white" ? "bg-white" : "bg-[#fbfaf6]";
  const panelClass = isDark ? "bg-[#242725] text-[#deded8] border-[#393d3a]" : "bg-[#fbfaf6] text-ink border-[#d8d8d1]";
  const chromeClass = isDark ? "border-[#303431] bg-[#151716]/90" : paperColor === "white" ? "border-[#d6d8d3] bg-[#edf0f0]/90" : "border-[#d6d8d3] bg-[#e8e9e4]/90";
  const controlClass = `flex h-11 w-11 shrink-0 items-center justify-center border bg-transparent font-sans text-[10px] leading-none cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-red md:h-12 md:w-12 md:text-xs ${isDark ? "border-[#444844] hover:bg-[#2b2f2c]" : "border-[#d2d3ce] hover:bg-white"}`;
  const firstPhysicalPage = pageMetrics.page * pageMetrics.columnsPerSpread + 1;
  const lastPhysicalPage = Math.min(firstPhysicalPage + pageMetrics.columnsPerSpread - 1, pageMetrics.physicalPages);

  const tocList = <div ref={tocPanelRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
    <ol className="m-0 list-none px-4 py-3">{(mobileViewport ? toc : filteredToc).map((item) => <li key={item.id}><button type="button" data-toc-active={activeChapterId === item.targetId ? "true" : undefined} onClick={() => chooseChapter(item.targetId)} style={{ paddingLeft: `${16 + item.depth * 16}px` }} className={`relative block w-full border-0 bg-transparent py-3 pr-4 text-left font-serif text-[13px] leading-relaxed cursor-pointer ${activeChapterId === item.targetId ? "font-bold text-red before:absolute before:inset-y-2 before:right-0 before:w-[2px] before:bg-red" : "text-current hover:text-red"}`}>{item.title}</button></li>)}</ol>
    {filteredToc.length === 0 && !mobileViewport && <p className="px-7 py-10 text-center font-sans text-xs text-muted">没有匹配的目录项</p>}
  </div>;

  const chapterNavigation = !contentLoading && <nav aria-label="章节导航" className="mt-20 grid grid-cols-2 border-t border-rule pt-8 font-sans text-xs [break-inside:avoid]">
    <button type="button" disabled={!previousChapter} onClick={() => chooseChapter(previousChapter?.id, "end")} className="border-0 bg-transparent py-4 pr-4 text-left text-current cursor-pointer disabled:cursor-default disabled:opacity-30"><span className="mb-1 block text-muted">上一节</span>{previousChapter?.title ?? "已经是第一节"}</button>
    <button type="button" disabled={!nextChapter} onClick={() => chooseChapter(nextChapter?.id)} className="border-0 border-l border-rule bg-transparent py-4 pl-4 text-right text-current cursor-pointer disabled:cursor-default disabled:opacity-30"><span className="mb-1 block text-muted">下一节</span>{nextChapter?.title ?? "已经是最后一节"}</button>
  </nav>;

  return <ReadingBookshelfContext.Provider value={{
    available: bookshelfEnabled,
    added: onBookshelf,
    busy: bookshelfBusy,
    toggle: () => void toggleBookshelf(),
    speechLauncherTarget,
    chromeHidden: mobileChromeHidden || readerOverlayOpen,
  }}><div data-reader-chrome-hidden={mobileChromeHidden || undefined} className={`book-reader book-reader-root h-screen overflow-hidden ${isDark ? "book-reader-dark" : ""} ${shellClass}`}>
    {mobileViewport ? <nav {...chromeProps} data-book-toolbar data-reader-mobile-toolbar aria-label="阅读工具" className={`book-mobile-toolbar z-30 grid-cols-4 border-t backdrop-blur-md ${chromeClass}`}>
      <button type="button" onClick={() => openPanel("toc")} className="book-mobile-tool" aria-label="打开目录" aria-pressed={tocOpen}>
        <ReaderToolIcon name="toc" /><span>目录</span>
      </button>
      <button type="button" onClick={openBookAi} className="book-mobile-tool" aria-label="打开书内 AI" aria-pressed={aiOpen}>
        <ReaderToolIcon name="ai" /><span>AI</span>
      </button>
      <button type="button" onClick={() => openTool("progress")} className="book-mobile-tool" aria-label="阅读进度" aria-pressed={toolPopover === "progress"}>
        <ReaderToolIcon name="progress" /><span>{bookProgress}%</span>
      </button>
      <button type="button" onClick={() => openTool("display")} className="book-mobile-tool" aria-label="显示设置" aria-pressed={toolPopover === "display"}>
        <ReaderToolIcon name="display" /><span>显示</span>
      </button>
    </nav> : <nav data-book-toolbar aria-label="阅读工具" className={`fixed bottom-auto left-auto right-5 top-1/2 z-30 flex -translate-y-1/2 flex-col gap-2 overflow-visible border-0 p-0 backdrop-blur-md ${chromeClass}`}>
      <button type="button" onClick={() => openPanel("toc")} className={controlClass} aria-label="打开目录" title="目录">目录</button>
      <button type="button" onClick={() => openPanel("search")} className={controlClass} aria-label="搜索全书" title="搜索全书">搜索</button>
      <button type="button" onClick={openBookAi} className={`${controlClass} relative`} aria-label="打开书内 AI" title={agentAccess ? "书内 AI · Beta（实验功能）" : "登录后使用书内 AI"}>AI<span aria-hidden="true" className="absolute right-1.5 top-1.5 text-[6px] font-bold leading-none tracking-normal text-red">Beta</span></button>
      {speechEnabled && speechControl && <div ref={setSpeechLauncherTarget} className="h-12 w-12 shrink-0" />}
      <button type="button" onClick={() => openTool("font")} className={controlClass} aria-label="调整字号" title="字号">字号</button>
      <button type="button" onClick={() => openTool("color")} className={controlClass} aria-label="选择纸张颜色" title="纸张颜色"><span className={`h-4 w-4 border ${isDark ? "border-white/50 bg-[#202321]" : paperColor === "white" ? "border-[#aaa] bg-white" : "border-[#b8ad96] bg-[#fbfaf6]"}`} aria-hidden="true" /></button>
      <button type="button" aria-pressed={paperTexture} onClick={() => setPaperTexture((value) => !value)} className={`${controlClass} ${paperTexture ? "text-red" : ""}`} aria-label="切换纸张纹理" title={paperTexture ? "关闭纸张纹理" : "开启纸张纹理"}>纹理</button>
      <button type="button" data-reader-mode={mode} onClick={() => changeMode(mode === "paged" ? "scroll" : "paged")} className={controlClass} aria-label="切换阅读模式" title={mode === "paged" ? "切换为上下滚动" : "切换为双页阅读"}>{mode === "paged" ? "双页" : "滚动"}</button>
      {onDownload && <button type="button" onClick={onDownload} className={`${controlClass} mt-3`} aria-label="下载整本 EPUB" title="下载整本 EPUB"><svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 20h14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" /></svg></button>}
    </nav>}
    {speechEnabled && speechControl}

    {mobileViewport && (tocOpen || searchOpen) && <BookNavigationSheet tab={tocOpen ? "toc" : "search"} onTabChange={openPanel} onClose={() => { setTocOpen(false); setSearchOpen(false); }} panelClass={panelClass}>
      {tocOpen ? tocList : <BookSearchPanel embedded bookTitle={bookTitle} panelClass={panelClass} onClose={() => setSearchOpen(false)} onJump={locateSearchResult} onSearch={onSearch} />}
    </BookNavigationSheet>}

    {!mobileViewport && tocOpen && <>
      <button type="button" aria-label="关闭目录" onClick={() => setTocOpen(false)} className="fixed inset-0 z-40 border-0 bg-black/20 cursor-default" />
      <aside aria-label="目录面板" className={`fixed inset-y-0 right-0 z-50 flex w-full flex-col overflow-hidden border-l shadow-[-18px_0_50px_rgba(0,0,0,.12)] sm:w-[min(88vw,420px)] ${panelClass}`}>
        <div className={`z-10 shrink-0 border-b ${panelClass}`}>
          <div className="px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div><p className="m-0 font-sans text-[11px] tracking-[.22em] text-muted">目录</p><h2 className="mb-1 mt-2 text-xl leading-snug">{bookTitle}</h2><p className="m-0 font-sans text-xs text-muted">{logicalChapterCount ? `${logicalChapterCount} 章 · ` : ""}{characterCount.toLocaleString()} 字</p></div>
            <button type="button" onClick={() => setTocOpen(false)} className="border-0 bg-transparent text-2xl cursor-pointer text-current" aria-label="关闭目录">×</button>
          </div>
          <label className={`book-toc-search-shell mt-5 flex h-10 items-center gap-3 border-0 border-b px-0 font-sans text-xs ${isDark ? "border-[#4a4d4a]" : "border-[#b9bab4]"}`}>
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="m15.5 15.5 5 5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
            <input value={tocQuery} onChange={(event) => setTocQuery(event.target.value)} placeholder="搜索目录" aria-label="搜索目录" className="book-toc-search min-w-0 flex-1 text-base text-current placeholder:text-muted" />
          </label>
          </div>
        </div>
        {tocList}
      </aside>
    </>}

    {!mobileViewport && searchOpen && <><button type="button" aria-label="关闭全书搜索" onClick={() => setSearchOpen(false)} className="fixed inset-0 z-40 border-0 bg-black/20 cursor-default" /><BookSearchPanel bookTitle={bookTitle} panelClass={panelClass} onClose={() => setSearchOpen(false)} onJump={locateSearchResult} onSearch={onSearch} /></>}

    {agentAccess && aiOpen && <><button type="button" aria-label="关闭书内 AI" onClick={closeAiPanel} className="fixed inset-0 z-40 border-0 bg-black/20 cursor-default" /><BookAiPanel key={`${aiQuestion || "book-ai"}:${aiInitialAnswer || ""}`} bookTitle={bookTitle} datasetId={datasetId} itemId={itemId} manifestObject={manifestObject} initialQuestion={aiQuestion} initialAnswer={aiInitialAnswer} initialReferences={aiInitialReferences} preparing={aiPreparing} explanationQuote={aiExplanationQuote} focus={aiFocus} panelClass={panelClass} onClose={closeAiPanel} onExplanationComplete={(quote: string, answer: string, references?: RagReference[], metadata?: RagAnswerMetadata) => {
      if (quote.length <= 2_000) void saveExplanation({
        datasetId,
        itemId,
        chapterId: aiFocus?.chapterId ?? activeChapterId,
        quote,
        prefix: aiFocus?.prefix,
        suffix: aiFocus?.suffix,
        answer,
        references,
        metadata,
      }).catch(() => undefined);
    }} /></>}

    {activeAnnotation && currentUserId ? <AnnotationDiscussionPanel key={activeAnnotation.id}
      thread={activeAnnotation}
      currentUserId={currentUserId}
      onClose={() => setActiveAnnotationId(undefined)}
      onComment={(body, parentCommentId, visibility) => annotations.comment(activeAnnotation.id, body, parentCommentId, visibility)}
      onReport={(commentId, reason, details) => annotations.report(activeAnnotation.id, commentId, reason, details)}
    /> : null}

    {toolPopover && <>
      <button type="button" aria-label="关闭阅读工具" onClick={() => setToolPopover(undefined)} className={`fixed inset-0 z-20 border-0 cursor-default ${mobileViewport ? "bg-black/15" : "bg-transparent"}`} />
      <section className={`${mobileViewport ? "book-mobile-sheet fixed inset-x-0 z-40 border-t px-5 pb-5 pt-3 shadow-[0_-16px_45px_rgba(0,0,0,.16)]" : "fixed bottom-auto left-auto right-20 top-1/2 z-40 w-64 -translate-y-1/2 border p-4 shadow-[6px_10px_30px_rgba(0,0,0,.14)]"} ${panelClass}`} aria-label={toolPopover === "font" ? "字号工具" : toolPopover === "color" ? "纸张颜色工具" : toolPopover === "progress" ? "阅读进度面板" : "显示设置面板"}>
        {mobileViewport && <div className="mb-3 flex items-center justify-between border-b border-rule pb-3">
          <div><p className="m-0 font-sans text-[10px] font-bold tracking-[.18em] text-red">阅读工具</p><h2 className="mb-0 mt-1 font-serif text-lg">{toolPopover === "progress" ? "阅读进度" : "显示设置"}</h2></div>
          <button type="button" onClick={() => setToolPopover(undefined)} className="flex h-10 w-10 items-center justify-center border-0 bg-transparent text-2xl text-current" aria-label="关闭阅读工具">×</button>
        </div>}
        {toolPopover === "progress" ? <div className="pb-2">
          <div className="mb-5 grid grid-cols-2 divide-x divide-rule border-y border-rule py-4 text-center font-sans">
            <div><strong className="block font-serif text-2xl font-semibold text-red">{bookProgress}%</strong><span className="mt-1 block text-[11px] text-muted">全书进度</span></div>
            <div><strong className="block font-serif text-base font-semibold">{mode === "paged" ? `${firstPhysicalPage}${firstPhysicalPage === lastPhysicalPage ? "" : `–${lastPhysicalPage}`} / ${pageMetrics.physicalPages} 页` : `本章 ${readingProgress}%`}</strong><span className="mt-2 block max-w-[15rem] truncate px-3 text-[11px] text-muted">{chapters[activeChapterIndex]?.title || "正文"}</span></div>
          </div>
          <label className="mb-2 flex items-center justify-between font-sans text-[11px] text-muted"><span>本章开头</span><span>本章结尾</span></label>
          <input type="range" min="0" max="100" value={readingProgress} onChange={(event) => seekReadingProgress(+event.target.value)} className="book-reader-range book-reader-range--mobile w-full" aria-label="本章进度" />
        </div> : toolPopover === "display" ? <div className="space-y-5 pb-1">
          <div>
            <div className="mb-2 flex items-center justify-between font-sans text-xs text-muted"><span>字号</span><span className="font-serif text-base text-current">{fontSize}px</span></div>
            <div className="grid grid-cols-[24px_1fr_28px] items-center gap-3"><span className="font-serif text-sm">A</span><input type="range" min="14" max="24" value={fontSize} onChange={(event) => setFontSize(+event.target.value)} className="book-reader-range book-reader-range--mobile w-full" aria-label="字号" /><span className="font-serif text-2xl">A</span></div>
          </div>
          <div>
            <p className="mb-2 mt-0 font-sans text-xs text-muted">纸张颜色</p>
            <div className="grid grid-cols-3 gap-2">{(["ivory", "white", "dark"] as BookReaderPaperColor[]).map((value) => <button type="button" key={value} aria-pressed={paperColor === value} onClick={() => setPaperColor(value)} className={`book-paper-choice h-14 border font-sans text-xs ${value === "ivory" ? "bg-[#fbfaf6] text-ink" : value === "white" ? "bg-white text-ink" : "bg-[#202321] text-white"} ${paperColor === value ? "border-red outline outline-2 outline-offset-[-3px] outline-red" : "border-rule"}`}>{value === "ivory" ? "米白" : value === "white" ? "纯白" : "夜间"}</button>)}</div>
          </div>
          <div className="grid grid-cols-2 gap-2 font-sans text-xs">
            <button type="button" aria-label="纸张纹理" aria-pressed={paperTexture} onClick={() => setPaperTexture((value) => !value)} className={`book-setting-choice ${paperTexture ? "is-active" : ""}`}><span>纸张纹理</span><strong>{paperTexture ? "开" : "关"}</strong></button>
            <div className="grid grid-cols-2 border border-rule p-1">
              <button type="button" aria-pressed={mode === "paged"} onClick={() => changeMode("paged")} className={`border-0 px-1 py-3 ${mode === "paged" ? "bg-red text-white" : "bg-transparent text-current"}`}>翻页</button>
              <button type="button" aria-pressed={mode === "scroll"} onClick={() => changeMode("scroll")} className={`border-0 px-1 py-3 ${mode === "scroll" ? "bg-red text-white" : "bg-transparent text-current"}`}>滚动</button>
            </div>
          </div>
          {onDownload && <button type="button" onClick={onDownload} className="book-download-action">下载整本 EPUB</button>}
        </div> : toolPopover === "font" ? <>
          <label className="mb-3 flex items-center justify-between font-sans text-xs text-muted"><span>字号</span><span>{fontSize}px</span></label>
          <input type="range" min="14" max="24" value={fontSize} onChange={(event) => setFontSize(+event.target.value)} className="book-reader-range w-full" aria-label="字号" />
        </> : <>
          <p className="mb-3 mt-0 font-sans text-xs text-muted">纸张颜色</p>
          <div className="grid grid-cols-3 gap-2">{(["ivory", "white", "dark"] as BookReaderPaperColor[]).map((value) => <button type="button" key={value} onClick={() => { setPaperColor(value); setToolPopover(undefined); }} className={`h-12 border cursor-pointer ${value === "ivory" ? "bg-[#fbfaf6] text-ink" : value === "white" ? "bg-white text-ink" : "bg-[#202321] text-white"} ${paperColor === value ? "border-red outline outline-1 outline-red" : "border-rule"}`}>{value === "ivory" ? "米白" : value === "white" ? "白色" : "夜间"}</button>)}</div>
        </>}
      </section>
    </>}

    {textSelection && <BookSelectionPopover rect={textSelection.rect} width={annotationAccess ? 272 : 144}>
      <div className="book-selection-actions" role="toolbar" aria-label="选中文字工具">
        <button type="button" onClick={() => void copySelection()} className="reader-selection-action"><IoCopyOutline aria-hidden="true" /><span>复制</span></button>
        {annotationAccess && <><button type="button" disabled={annotationSaving} onClick={() => void underlineSelection()} className="reader-selection-action"><span aria-hidden="true" className="book-selection-underline">A</span><span>划线</span></button>
        <button type="button" disabled={annotationSaving} onClick={composeThought} className="reader-selection-action"><IoCreateOutline aria-hidden="true" /><span>写想法</span></button></>}
        <button type="button" onClick={() => agentAccess ? void explainSelection() : openBookAi()} className="reader-selection-action" aria-label="AI 解释"><IoSparklesOutline aria-hidden="true" /><span>AI 解释</span></button>
      </div>
    </BookSelectionPopover>}

    {thoughtSelection && <BookThoughtComposer quote={thoughtSelection.text} value={thought} visibility={thoughtVisibility}
      saving={annotationSaving} error={thoughtError} panelClass={panelClass} onChange={setThought} onVisibilityChange={setThoughtVisibility}
      onSave={() => void saveThought()} onClose={clearSelection} />}

    {readerNotice && <button type="button" onClick={() => setReaderNotice("")} className={`fixed bottom-20 left-1/2 z-[66] -translate-x-1/2 border px-4 py-2 font-sans text-xs shadow-lg md:bottom-6 ${panelClass}`}>{readerNotice}</button>}

    <header {...chromeProps} className={`relative z-20 h-12 border-b backdrop-blur-md ${chromeClass}`}>
      <div className="mx-auto flex h-full max-w-[1180px] items-center gap-3 px-4 font-sans text-xs md:px-10">
        <Link to={backHref} className="flex h-7 w-6 shrink-0 items-center justify-start text-current no-underline hover:text-red focus-visible:outline-2 focus-visible:outline-red" aria-label="返回上一页">
          <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden="true">
            <path d="m8.5 4.5-5.5 5.5 5.5 5.5M3.5 10H17" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="square" />
          </svg>
        </Link>
        <span className="max-w-[52vw] shrink truncate text-muted md:max-w-[min(34vw,28rem)]">{bookTitle}</span>
        {bookshelfEnabled && <button
          type="button"
          aria-pressed={onBookshelf}
          disabled={bookshelfBusy}
          aria-label={onBookshelf ? "移出书架" : "加入书架"}
          title={onBookshelf ? "移出书架" : "加入书架"}
          onClick={() => void toggleBookshelf()}
          className={`group flex h-8 shrink-0 items-center gap-1.5 border-0 bg-transparent px-2 font-sans text-[11px] cursor-pointer focus-visible:outline-2 focus-visible:outline-red ${onBookshelf ? "text-red" : "text-muted hover:text-red"}`}
        >
          <svg viewBox="0 0 30 24" className="h-4 w-5" aria-hidden="true">
            <path d="M3 5.5c4-.5 7 .5 9 2.5 2-2 5-3 9-2.5v14c-4-.5-7 .5-9 2.5-2-2-5-3-9-2.5zM12 8v14" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="miter" />
            {onBookshelf
              ? <path d="m23 9 1.75 1.75 3.25-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" />
              : <path d="M26 5v7M22.5 8.5h7" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="square" />}
          </svg>
          <span className="hidden sm:inline">{onBookshelf ? "已在书架" : "加入书架"}</span>
        </button>}
        <span className="min-w-0 flex-1" aria-hidden="true" />
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

    {mode === "scroll" ? <div ref={scrollRef} data-book-reading-surface onScroll={updateScrollProgress} onClick={handleReaderClick} onPointerDown={startReaderTap} onPointerMove={moveReaderTap} onPointerCancel={cancelReaderTap} onPointerUp={capturePointerTextSelection} onKeyUp={captureTextSelection} className="h-[calc(100%-48px)] overflow-y-auto">
      <main className="mx-auto max-w-[920px] px-0 py-0 md:px-5 md:py-8">
        <article className={`relative min-h-full border-0 px-6 pb-32 pt-10 shadow-none sm:px-12 md:min-h-[calc(100vh-96px)] md:border-x md:px-20 md:py-20 md:shadow-[0_16px_50px_rgba(32,32,28,.10)] ${pageClass} ${paperTexture ? "book-page-texture" : ""} ${isDark ? "md:border-[#2d312e]" : "md:border-[#ddddd6]"}`} style={{ fontSize: `${fontSize}px`, lineHeight: 2.05 }}>
          <div className="mx-auto max-w-[730px]">{error && <p className="border-l-4 border-red bg-red/5 px-4 py-3 text-sm text-red">{error}</p>}{children}{chapterNavigation}</div>
        </article>
      </main>
    </div> : <main className="relative h-[calc(100%-48px)] px-0 py-0 md:px-20 md:py-6">
      <div className="relative mx-auto h-full max-w-[1180px]">
        <article className={`relative h-full overflow-hidden border-0 px-6 pb-32 pt-10 shadow-none sm:px-10 md:border md:px-16 md:py-14 md:shadow-[0_16px_55px_rgba(32,32,28,.14)] ${pageClass} ${paperTexture ? "book-page-texture" : ""} ${isDark ? "md:border-[#2d312e]" : "md:border-[#d8d8d1]"}`}>
          {columnsPerSpread === 2 && <div className={`pointer-events-none absolute inset-y-0 left-1/2 z-10 w-10 -translate-x-1/2 ${isDark ? "bg-[linear-gradient(90deg,transparent,rgba(0,0,0,.22),transparent)]" : "bg-[linear-gradient(90deg,transparent,rgba(77,75,66,.09),transparent)]"}`} aria-hidden="true" />}
          <div ref={flowRef} data-book-page-flow data-book-reading-surface onClick={handleReaderClick} onPointerDown={startReaderTap} onPointerMove={moveReaderTap} onPointerCancel={cancelReaderTap} onPointerUp={capturePointerTextSelection} onKeyUp={captureTextSelection} className={`relative h-full overflow-hidden [column-fill:auto] [&_img]:cursor-zoom-in [&_figure]:break-inside-avoid [&_h1]:[break-after:avoid-column] [&_h2]:[break-after:avoid-column] [&_li]:break-inside-avoid ${pageTransitioning ? "book-page-content-arrive" : ""}`} style={{ columnCount: columnsPerSpread, columnGap: columnsPerSpread === 2 ? "80px" : "48px", fontSize: `${fontSize}px`, lineHeight: 1.95 }}>
            {error && <p className="border-l-4 border-red bg-red/5 px-4 py-3 text-sm text-red">{error}</p>}{children}
            {trailingBlankPage && <span data-book-trailing-page className="book-page-trailing-blank" aria-hidden="true" />}
          </div>
        </article>
        <button {...chromeProps} type="button" onClick={previousPage} disabled={pageTransitioning || (!previousChapter && pageMetrics.page === 0)} className={`book-page-turn-control absolute left-5 z-30 flex h-10 items-center justify-center gap-1 border px-3 font-sans text-xs shadow-[2px_4px_14px_rgba(0,0,0,.08)] cursor-pointer transition-colors disabled:cursor-default disabled:opacity-20 sm:left-8 ${panelClass}`} aria-label="上一页" title="上一页（←）"><span aria-hidden="true">‹</span> 上一页</button>
        <button {...chromeProps} type="button" onClick={nextPage} disabled={pageTransitioning || (!nextChapter && pageMetrics.page >= pageMetrics.spreads - 1)} className={`book-page-turn-control absolute right-5 z-30 flex h-10 items-center justify-center gap-1 border px-3 font-sans text-xs shadow-[2px_4px_14px_rgba(0,0,0,.08)] cursor-pointer transition-colors disabled:cursor-default disabled:opacity-20 sm:right-8 ${panelClass}`} aria-label="下一页" title="下一页（→ 或空格）">下一页 <span aria-hidden="true">›</span></button>
      </div>
      <div {...chromeProps} className="book-page-number pointer-events-none absolute inset-x-0 flex items-center justify-center gap-4 font-sans text-[10px] text-muted">
        <span>{firstPhysicalPage === lastPhysicalPage ? firstPhysicalPage : `${firstPhysicalPage}–${lastPhysicalPage}`} / {pageMetrics.physicalPages} 页</span>
      </div>
    </main>}
  </div></ReadingBookshelfContext.Provider>;
}
