import {
  type CSSProperties,
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
import { IoBookOutline, IoCopyOutline, IoCreateOutline, IoDownloadOutline, IoListOutline, IoRadioButtonOnOutline, IoSearchOutline, IoSparklesOutline, IoTextOutline } from "react-icons/io5";
import { bookProgressPercent, bookProgressLocation, estimatedReadingMinutes, formatReadingTime, type SpeechLocation } from "@jojo/content";
import { createSpeechReader, SPEECH_EXCLUDED_ELEMENTS } from "@jojo/content/speech-dom";
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
import { ContinuousBookContent, type ContinuousBookContentHandle } from "./ContinuousBookContent";
import { ReaderSelectionPopover } from "../../reading/ReaderSelectionPopover";
import { BookThoughtComposer } from "./BookThoughtComposer";
import { useBookReadingTime } from "../../reading/readingStats";
import { loadMyBookAnnotations } from "../../annotations/api";
import type { AnnotationThread } from "../../annotations/types";
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
type ReaderToolPopover = "display" | "progress" | "notes";
type ReaderToolIconName = "toc" | "search" | "ai" | "progress" | "display";

function ReaderToolIcon({ name }: { name: ReaderToolIconName }) {
  const Icon = { toc: IoListOutline, search: IoSearchOutline, ai: IoSparklesOutline, progress: IoRadioButtonOnOutline, display: IoTextOutline }[name];
  return <Icon aria-hidden="true" />;
}

const RANGE_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"];

function rangeFill(percent: number): CSSProperties {
  return { "--reader-range-fill": `${Math.max(0, Math.min(100, percent))}%` } as CSSProperties;
}

function scopedAnchor(root: HTMLElement | null | undefined, id: string): HTMLElement | undefined {
  if (!root || !id) return;
  const candidate = document.getElementById(id);
  return candidate && root.contains(candidate) ? candidate : Array.from(root.querySelectorAll<HTMLElement>("[id]")).find((element) => element.id === id);
}

export interface BookReaderChapter {
  id: string;
  title: string;
  characterCount?: number;
}

export interface BookReaderTocItem extends BookReaderChapter {
  targetId?: string;
  anchorId?: string;
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
  loadChapter?: (chapterId: string, signal: AbortSignal) => Promise<ReactNode>;
  onVisibleChapterChange?: (chapterId: string) => void;
  speechControl?: ReactNode;
  children: ReactNode;
}

interface ExpandedImage {
  src: string;
  alt: string;
}

interface ReaderTextSelection {
  chapterId?: string;
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
  contentLoading: chapterLoading = false,
  error,
  backHref,
  onChapterChange,
  onLocate,
  onInternalLink,
  onSearch,
  onDownload,
  loadChapter,
  onVisibleChapterChange,
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
  const continuous = mode === "scroll" && Boolean(loadChapter);
  const [continuousReady, setContinuousReady] = useState(false);
  const contentLoading = continuous ? !continuousReady : chapterLoading;
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
  const [discussionChapterId, setDiscussionChapterId] = useState<string>();
  const [annotationSaving, setAnnotationSaving] = useState(false);
  const [onBookshelf, setOnBookshelf] = useState(false);
  const [bookshelfBusy, setBookshelfBusy] = useState(false);
  const [readerNotice, setReaderNotice] = useState("");
  const [popular, setPopular] = useState<ReusableExplanation[]>([]);
  const [expandedImage, setExpandedImage] = useState<ExpandedImage>();
  const [readingProgress, setReadingProgress] = useState(0);
  const [progressPreview, setProgressPreview] = useState<number>();
  const [bookNotes, setBookNotes] = useState<AnnotationThread[]>([]);
  const [notesError, setNotesError] = useState("");
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesRevision, setNotesRevision] = useState(0);
  const [activeTocId, setActiveTocId] = useState<string>();
  const [positionRevision, setPositionRevision] = useState(0);
  const [columnsPerSpread, setColumnsPerSpread] = useState(() => window.innerWidth >= 900 ? 2 : 1);
  const [mobileViewport, setMobileViewport] = useState(() => window.innerWidth < 768);
  const [chromeHidden, setChromeHidden] = useState(false);
  const mobileChromeHidden = mobileViewport && chromeHidden;
  const chromeProps = { "data-reader-chrome": true, "aria-hidden": mobileChromeHidden || undefined, inert: mobileChromeHidden };
  const readerTapRef = useRef<{ x: number; y: number; started: number; cancelled: boolean } | null>(null);
  const [speechLauncherTarget, setSpeechLauncherTarget] = useState<HTMLDivElement | null>(null);
  const [pageMetrics, setPageMetrics] = useState<PageMetrics>(DEFAULT_PAGE_METRICS);
  const [trailingBlankPage, setTrailingBlankPage] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<HTMLDivElement>(null);
  const continuousRef = useRef<ContinuousBookContentHandle>(null);
  const visibleChapterRef = useRef(activeChapterId);
  const requestedScrollChapterRef = useRef<string | undefined>(undefined);
  const tocPanelRef = useRef<HTMLDivElement>(null);
  const currentPageRef = useRef(0);
  const pendingPageRef = useRef<"start" | "end" | null>("start");
  const pendingProgressRef = useRef<{ chapterId: string; progress: number }>(undefined);
  const swipeRef = useRef<{ x: number; y: number; time: number; dragging: boolean; start: number; distance: number }>(undefined);
  const suppressSwipeClickRef = useRef(false);
  const jumpTimerRef = useRef<number | undefined>(undefined);
  const aiPreparationRef = useRef(0);

  const activeChapterIndex = Math.max(0, chapters.findIndex((chapter) => chapter.id === activeChapterId));
  const annotationChapterId = thoughtSelection?.chapterId || textSelection?.chapterId || (activeAnnotationId && discussionChapterId) || activeChapterId;
  const annotationSubject = useMemo(() => ({
    contentType: "book" as const,
    contentId: `${datasetId}:${itemId}`,
    sectionId: annotationChapterId,
    contentTitle: `${bookTitle} · ${chapters.find((chapter) => chapter.id === annotationChapterId)?.title || "正文"}`,
    contentUrl: `${window.location.pathname}?${new URLSearchParams({ chapter: annotationChapterId })}`,
  }), [annotationChapterId, bookTitle, chapters, datasetId, itemId]);

  const chapterRoot = useCallback((id = activeChapterId): HTMLElement | null => continuous
    ? continuousRef.current?.getChapterRoot(id)?.querySelector<HTMLElement>("[data-speech-content]") ?? null
    : mode === "paged" ? flowRef.current : scrollRef.current, [activeChapterId, continuous, mode]);

  const continuousPosition = useCallback((id: string, progress: number) => {
    requestedScrollChapterRef.current = undefined;
    setReadingProgress(progress);
    if (visibleChapterRef.current !== id) {
      visibleChapterRef.current = id;
      onVisibleChapterChange?.(id);
    }
  }, [onVisibleChapterChange]);

  const continuousContentReady = useCallback(() => {
    setContinuousReady(true);
    setPositionRevision((revision) => revision + 1);
  }, []);

  useEffect(() => {
    if (!continuous) { setContinuousReady(false); return; }
    if (activeChapterId === visibleChapterRef.current || requestedScrollChapterRef.current === activeChapterId) return;
    requestedScrollChapterRef.current = activeChapterId;
    const pending = pendingProgressRef.current;
    continuousRef.current?.seek(activeChapterId, pending?.chapterId === activeChapterId ? pending.progress : 0);
    pendingProgressRef.current = undefined;
  }, [activeChapterId, continuous]);
  const annotationAccess = annotationsEnabled && Boolean(currentUserId);
  const annotations = useAnnotationThreads(annotationSubject, annotationAccess, currentUserId);
  const activeAnnotation = annotations.threads.find((thread) => thread.id === activeAnnotationId);
  const readerOverlayOpen = aiOpen || tocOpen || searchOpen || Boolean(toolPopover || thoughtSelection || activeAnnotation || expandedImage);
  const previousChapter = chapters[activeChapterIndex - 1];
  const nextChapter = chapters[activeChapterIndex + 1];
  const exactBookProgress = bookProgressPercent(chapters, activeChapterId, readingProgress);
  const bookProgress = Math.round(exactBookProgress * 10) / 10;
  const readingSeconds = useBookReadingTime(`${currentUserId || "guest"}:${datasetId}:${itemId}`, !contentLoading && !error && !readerOverlayOpen);
  const remainingMinutes = estimatedReadingMinutes(characterCount, exactBookProgress);
  const previewLocation = bookProgressLocation(chapters, progressPreview ?? exactBookProgress);

  const annotationSectionIds = useMemo(() => [activeChapterId, ...chapters.map((chapter) => chapter.id).filter((id) => id !== activeChapterId)], [activeChapterId, chapters]);

  useEffect(() => { setBookNotes([]); setNotesError(""); }, [currentUserId, datasetId, itemId]);

  useEffect(() => {
    if (toolPopover !== "notes" && toolPopover !== "progress") return;
    if (!annotationAccess) { setBookNotes([]); return; }
    let active = true;
    const controller = new AbortController();
    setNotesLoading(true); setNotesError("");
    void loadMyBookAnnotations(`${datasetId}:${itemId}`, annotationSectionIds, currentUserId ?? null, {
      signal: controller.signal,
      onProgress: ({ notes }) => { if (active) setBookNotes(notes); },
    }).then((notes) => { if (active) setBookNotes(notes); })
      .catch(() => { if (active) setNotesError("笔记暂时无法读取，请重试。"); })
      .finally(() => { if (active) setNotesLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [annotationAccess, currentUserId, datasetId, itemId, toolPopover, annotations.threads, annotationSectionIds, notesRevision]);

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
    if (!flow || mode !== "paged" || swipeRef.current?.dragging) return;
    const gap = Number.parseFloat(window.getComputedStyle(flow).columnGap) || 64;
    const columnStep = (flow.clientWidth + gap) / columnsPerSpread;
    const measuredPages = Math.max(1, Math.ceil((flow.scrollWidth + gap - 1) / columnStep));
    const physicalPages = Math.max(1, measuredPages - (trailingBlankPage ? 1 : 0));
    const needsTrailingBlankPage = columnsPerSpread === 2 && physicalPages % 2 === 1;
    if (needsTrailingBlankPage !== trailingBlankPage) setTrailingBlankPage(needsTrailingBlankPage);
    const spreads = Math.max(1, Math.ceil(physicalPages / columnsPerSpread));
    const step = flow.clientWidth + gap;
    const pendingProgress = pendingProgressRef.current;
    const requestedPage = pendingProgress?.chapterId === activeChapterId
      ? Math.round(pendingProgress.progress / 100 * (spreads - 1))
      : pendingPageRef.current === "end"
      ? spreads - 1
      : pendingPageRef.current === "start"
        ? 0
        : Math.min(currentPageRef.current, spreads - 1);
    pendingPageRef.current = null;
    if (pendingProgress?.chapterId === activeChapterId) pendingProgressRef.current = undefined;
    currentPageRef.current = requestedPage;
    flow.scrollLeft = requestedPage * step;
    setPageMetrics({ page: requestedPage, spreads, physicalPages, columnsPerSpread, step });
    setReadingProgress(spreads <= 1 ? 100 : Math.round((requestedPage / (spreads - 1)) * 100));
  }, [activeChapterId, columnsPerSpread, mode, trailingBlankPage]);

  useEffect(() => {
    window.localStorage.setItem("jojo-reader-font-size", String(fontSize));
  }, [fontSize]);

  useEffect(() => { window.localStorage.setItem("jojo-reader-paper-color", paperColor); }, [paperColor]);

  useEffect(() => { window.localStorage.setItem("jojo-reader-paper-texture", String(paperTexture)); }, [paperTexture]);

  useEffect(() => {
    window.localStorage.setItem("jojo-reader-mode", mode);
  }, [mode]);

  useEffect(() => () => {
    if (jumpTimerRef.current) window.clearTimeout(jumpTimerRef.current);
  }, []);

  useEffect(() => {
    if (!tocOpen || tocQuery) return;
    const frame = window.requestAnimationFrame(() => {
      tocPanelRef.current?.querySelector<HTMLElement>("[data-toc-active='true']")?.scrollIntoView({ block: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [tocOpen, tocQuery, activeTocId]);

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

  useLayoutEffect(() => {
    if (continuous) return;
    scrollRef.current?.scrollTo({ top: 0 });
    flowRef.current?.scrollTo({ left: 0 });
    currentPageRef.current = 0;
    if (pendingPageRef.current === null) pendingPageRef.current = "start";
    setReadingProgress(0);
    setPageMetrics((current) => ({ ...current, page: 0 }));
    setExpandedImage(undefined);
    setTextSelection(undefined);
    setThoughtSelection(undefined);
  }, [chapterKey, continuous]);

  useLayoutEffect(() => {
    if (mode !== "scroll" || continuous || contentLoading) return;
    const reader = scrollRef.current;
    if (!reader) return;
    const pending = pendingProgressRef.current;
    const progress = pending?.chapterId === activeChapterId ? pending.progress : pendingPageRef.current === "end" ? 100 : 0;
    if (pending?.chapterId === activeChapterId || pendingPageRef.current) {
      reader.scrollTop = Math.max(0, reader.scrollHeight - reader.clientHeight) * progress / 100;
      setReadingProgress(progress);
      pendingProgressRef.current = undefined;
      pendingPageRef.current = null;
    }
  }, [activeChapterId, contentLoading, continuous, mode]);

  useEffect(() => {
    if (contentLoading) return;
    const surface = mode === "paged" ? flowRef.current : scrollRef.current;
    if (!surface) return;
    const bounds = surface.getBoundingClientRect();
    const candidates = toc.filter((item) => item.targetId === activeChapterId);
    let current = candidates[0];
    for (const item of candidates) {
      if (!item.anchorId) continue;
      const element = scopedAnchor(chapterRoot(), item.anchorId);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      if (mode === "scroll" ? rect.top <= bounds.top + 60 : rect.left < bounds.right && rect.top <= bounds.bottom) current = item;
    }
    setActiveTocId(current?.id);
  }, [activeChapterId, contentLoading, mode, positionRevision, readingProgress, toc, chapterRoot]);

  useEffect(() => {
    const flow = flowRef.current;
    if (!flow || mode !== "paged") return;
    let timer: number | undefined;
    const settled = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setPositionRevision((value) => value + 1), 100);
    };
    flow.addEventListener("scroll", settled);
    return () => { flow.removeEventListener("scroll", settled); window.clearTimeout(timer); };
  }, [mode, chapterKey]);

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
    const root = chapterRoot(annotationChapterId);
    if (!root || contentLoading) return;
    renderAnnotationMarks(root, annotations.threads.filter((thread) => thread.sectionId === annotationChapterId), (id) => {
      setDiscussionChapterId(annotationChapterId);
      setActiveAnnotationId(id);
    });
  }, [annotations.threads, annotationChapterId, contentLoading, chapterRoot, pageMetrics.step, positionRevision]);

  useEffect(() => {
    const root = chapterRoot();
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
  }, [activeChapterId, activeChapterTitle, contentLoading, chapterRoot, pageMetrics.step, popular, positionRevision]);

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
    setTocOpen(false);
    if (continuous) {
      const pending = pendingProgressRef.current;
      requestedScrollChapterRef.current = chapterId;
      continuousRef.current?.seek(chapterId, pending?.chapterId === chapterId ? pending.progress : destination === "end" ? 100 : 0);
      pendingProgressRef.current = undefined;
      if (chapterId !== activeChapterId) onChapterChange(chapterId);
      return;
    }
    if (chapterId === activeChapterId) return;
    pendingPageRef.current = destination;
    onChapterChange(chapterId);
  }, [activeChapterId, continuous, onChapterChange]);

  const speechReaderRef = useRef<ReturnType<typeof createSpeechReader> | null>(null);
  const [speechLocation, setSpeechLocation] = useState<SpeechLocation | null>(null);
  const revealSpeechRef = useRef(false);
  const getSpeechPosition = useCallback(() => speechReaderRef.current?.read() ?? null, []);
  const showSpeechLocation = useCallback((value: SpeechLocation | null, reveal = false) => {
    if (reveal || !value) revealSpeechRef.current = reveal;
    setSpeechLocation(value);
    if (value && reveal) chooseChapter(value.chapterId);
  }, [chooseChapter]);
  useEffect(() => {
    const surface = mode === "paged" ? flowRef.current : scrollRef.current;
    const root = continuous ? chapterRoot() : surface?.querySelector<HTMLElement>("[data-speech-content]");
    if (!surface || !root || contentLoading) return;
    const reader = createSpeechReader(root, () => surface.getBoundingClientRect(), SPEECH_EXCLUDED_ELEMENTS);
    speechReaderRef.current = reader;
    return () => { speechReaderRef.current = null; };
  }, [mode, contentLoading, chapterKey, chapterRoot, continuous, positionRevision]);
  useEffect(() => {
    const reader = speechReaderRef.current;
    if (!reader) return;
    if (!speechLocation || speechLocation.chapterId !== activeChapterId) return;
    const reveal = revealSpeechRef.current;
    reader.show(speechLocation.segments, speechLocation.index, reveal ? (range) => {
      const rect = range.getClientRects()[0];
      if (!rect) return;
      if (mode === "paged" && flowRef.current && pageMetrics.step > 0) {
        const flow = flowRef.current;
        goToPage(Math.floor((rect.left - flow.getBoundingClientRect().left + flow.scrollLeft + 1) / pageMetrics.step), "auto");
      } else if (scrollRef.current) {
        const scroll = scrollRef.current;
        const bounds = scroll.getBoundingClientRect();
        if (rect.top < bounds.top + 24 || rect.bottom > bounds.bottom - 80) {
          scroll.scrollTo({ top: scroll.scrollTop + rect.top - bounds.top - 24, behavior: "auto" });
        }
      }
      revealSpeechRef.current = false;
    } : undefined);
  }, [speechLocation, activeChapterId, chapterKey, mode, contentLoading, goToPage, pageMetrics.step, fontSize]);

  function changeMode(value: BookReaderMode): void {
    if (value === mode) return;
    pendingPageRef.current = "start";
    currentPageRef.current = 0;
    setReadingProgress(0);
    setPageMetrics((current) => ({ ...current, page: 0 }));
    setMode(value);
  }

  const previousPage = useCallback(() => {
    if (contentLoading) return;
    if (pageMetrics.page > 0) goToPage(pageMetrics.page - 1, "auto");
    else if (previousChapter) chooseChapter(previousChapter.id, "end");
  }, [contentLoading, chooseChapter, goToPage, pageMetrics.page, previousChapter]);

  const nextPage = useCallback(() => {
    if (contentLoading) return;
    if (pageMetrics.page < pageMetrics.spreads - 1) goToPage(pageMetrics.page + 1, "auto");
    else if (nextChapter) chooseChapter(nextChapter.id);
  }, [contentLoading, chooseChapter, goToPage, nextChapter, pageMetrics.page, pageMetrics.spreads]);

  useEffect(() => {
    if (mode !== "paged" || readerOverlayOpen) return;
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
  }, [mode, nextPage, previousPage, readerOverlayOpen]);

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
    const target = scopedAnchor(chapterRoot(), anchorId);
    if (target) revealElement(target);
  }, [revealElement, chapterRoot]);

  useEffect(() => {
    if (!focusAnchorId || contentLoading) return;
    const timer = window.setTimeout(() => revealAnchor(focusAnchorId), 80);
    return () => window.clearTimeout(timer);
  }, [contentLoading, focusAnchorId, pageMetrics.step, revealAnchor, positionRevision]);

  useEffect(() => {
    if (!focusText?.text || contentLoading) return;
    const timer = window.setTimeout(() => {
      const root = chapterRoot();
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
      const anchorTarget = focusAnchorId ? scopedAnchor(root, focusAnchorId) : null;
      if (anchorTarget) return;
      const title = root.querySelector<HTMLElement>("h1,h2,h3");
      if (title) revealElement(title);
    }, 140);
    return () => window.clearTimeout(timer);
  }, [contentLoading, focusAnchorId, focusText, mode, pageMetrics.step, revealElement, chapterRoot, positionRevision]);

  function startReaderTap(event: ReactPointerEvent<HTMLElement>): void {
    suppressSwipeClickRef.current = false;
    if (mode === "paged" && !contentLoading && !readerOverlayOpen && event.pointerType !== "mouse" && event.isPrimary !== false
      && !(event.target as Element).closest("a,button,input,textarea,[role='button']") && !window.getSelection()?.toString()) {
      swipeRef.current = { x: event.clientX, y: event.clientY, time: Date.now(), dragging: false, start: currentPageRef.current * pageMetrics.step, distance: 0 };
    }
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

  function moveReaderTap(event: ReactPointerEvent<HTMLElement>): void {
    const tap = readerTapRef.current;
    if (tap && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 10) tap.cancelled = true;
    const swipe = swipeRef.current;
    if (!swipe || !flowRef.current) return;
    const dx = event.clientX - swipe.x;
    const dy = event.clientY - swipe.y;
    if (!swipe.dragging) {
      if (Math.abs(dy) > Math.abs(dx) + 8 || Date.now() - swipe.time > 450 || window.getSelection()?.toString()) { swipeRef.current = undefined; return; }
      if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.3) return;
      swipe.dragging = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    event.preventDefault();
    swipe.distance = dx;
    const target = swipe.start - dx;
    const maximum = (pageMetrics.spreads - 1) * pageMetrics.step;
    flowRef.current.scrollLeft = Math.max(0, Math.min(maximum, target));
    const overshoot = target < 0 ? -target : target > maximum ? maximum - target : 0;
    flowRef.current.style.transform = overshoot ? `translateX(${overshoot * .3}px)` : "";
  }

  function finishReaderPointer(event: ReactPointerEvent<HTMLElement>): void {
    const swipe = swipeRef.current;
    swipeRef.current = undefined;
    if (!swipe?.dragging) { capturePointerTextSelection(); return; }
    suppressSwipeClickRef.current = true;
    if (flowRef.current) flowRef.current.style.transform = "";
    const distance = swipe.distance;
    const duration = Math.max(1, Date.now() - swipe.time);
    const turn = Math.abs(distance) > Math.min(90, pageMetrics.step * .2) || (Math.abs(distance) > 24 && Math.abs(distance) / duration > .45);
    const target = pageMetrics.page + (turn ? (distance < 0 ? 1 : -1) : 0);
    if (target < 0 && previousChapter) chooseChapter(previousChapter.id, "end");
    else if (target >= pageMetrics.spreads && nextChapter) chooseChapter(nextChapter.id);
    else goToPage(target, window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");
  }

  function cancelReaderTap(): void {
    if (readerTapRef.current) readerTapRef.current.cancelled = true;
    if (swipeRef.current?.dragging && flowRef.current) {
      flowRef.current.style.transform = "";
      flowRef.current.scrollLeft = currentPageRef.current * pageMetrics.step;
      suppressSwipeClickRef.current = true;
    }
    swipeRef.current = undefined;
  }

  function handleReaderClick(event: ReactMouseEvent<HTMLElement>): void {
    if (suppressSwipeClickRef.current) { suppressSwipeClickRef.current = false; event.preventDefault(); return; }
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
        && !readerOverlayOpen && !textSelection) {
        // Keyboard/assistive clicks have no pointer position and toggle tools.
        if (mode === "paged" && (tap || event.detail > 0)) {
          const bounds = event.currentTarget.getBoundingClientRect();
          const position = ((tap?.x ?? event.clientX) - bounds.left) / (bounds.width || window.innerWidth);
          if (position < 1 / 3) { previousPage(); return; }
          if (position > 2 / 3) { nextPage(); return; }
        }
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
    const sourceChapter = link.closest<HTMLElement>("[data-book-chapter-id]");
    const target = scopedAnchor(sourceChapter ?? chapterRoot(), anchorId);
    if (!anchorId || !target) return;
    event.preventDefault();
    revealElement(target);
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
    const selectionElement = ancestor instanceof Element ? ancestor : ancestor.parentElement;
    const selectedChapter = selectionElement?.closest<HTMLElement>("[data-book-chapter-id]");
    const root = selectedChapter?.querySelector<HTMLElement>("[data-speech-content]") ?? chapterRoot();
    if (selectedChapter && (!selectedChapter.contains(range.startContainer) || !selectedChapter.contains(range.endContainer))) { setTextSelection(undefined); return; }
    const anchor = root && textAnchorFromRange(root, range, 1_200);
    if (!insideReader || !anchor) { setTextSelection(undefined); return; }
    const rect = range.getBoundingClientRect();
    setTextSelection({
      chapterId: selectedChapter?.dataset.bookChapterId ?? activeChapterId,
      text: anchor.quote,
      anchor,
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
    });
  }, [activeChapterId, chapterRoot, readerOverlayOpen]);

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
      setDiscussionChapterId(thoughtSelection?.chapterId || activeChapterId);
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
    const selectionChapterId = textSelection.chapterId || activeChapterId;
    setAiFocus({
      chapterId: selectionChapterId,
      chapterTitle: chapters.find((chapter) => chapter.id === selectionChapterId)?.title,
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
      const reusable = await reusableExplanation(datasetId, itemId, selectionChapterId, quote, {
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
    if (continuous) { setTextSelection(undefined); return; }
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
    if (continuous) { continuousRef.current?.seek(activeChapterId, bounded); return; }
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

  function commitBookProgress(percent: number): void {
    const destination = bookProgressLocation(chapters, percent);
    setProgressPreview(undefined);
    if (!destination) return;
    if (destination.chapterId === activeChapterId && !contentLoading) seekReadingProgress(destination.chapterProgress);
    else {
      pendingProgressRef.current = { chapterId: destination.chapterId, progress: destination.chapterProgress };
      chooseChapter(destination.chapterId);
    }
  }

  const isDark = paperColor === "dark";
  const shellClass = isDark ? "bg-[#151716] text-[#deded8]" : paperColor === "white" ? "bg-[#edf0f0] text-ink" : "bg-[#e8e9e4] text-ink";
  const pageClass = isDark ? "bg-[#202321]" : paperColor === "white" ? "bg-white" : "bg-[#fbfaf6]";
  const panelClass = isDark ? "bg-[#242725] text-[#deded8] border-[#393d3a]" : "bg-[#fbfaf6] text-ink border-[#d8d8d1]";
  const chromeClass = isDark ? "border-[#303431] bg-[#151716]" : paperColor === "white" ? "border-[#d6d8d3] bg-[#edf0f0]" : "border-[#d6d8d3] bg-[#e8e9e4]";
  const firstPhysicalPage = pageMetrics.page * pageMetrics.columnsPerSpread + 1;
  const lastPhysicalPage = Math.min(firstPhysicalPage + pageMetrics.columnsPerSpread - 1, pageMetrics.physicalPages);

  const tocList = <div ref={tocPanelRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
    <ol className="book-toc-list">{filteredToc.map((item) => <li key={item.id} style={{ paddingLeft: `${item.depth * 20}px` }}>
      {item.targetId ? <button type="button" data-toc-active={activeTocId === item.id ? "true" : undefined} aria-current={activeTocId === item.id ? "location" : undefined} onClick={() => {
        setTocOpen(false);
        if (item.targetId === activeChapterId && item.anchorId) revealAnchor(item.anchorId);
        else if (item.anchorId) onInternalLink?.(item.targetId!, item.anchorId);
        else chooseChapter(item.targetId);
      }}><span>{item.title}</span>{activeTocId === item.id && <small><IoBookOutline aria-hidden="true" /> 当前读到</small>}</button> : <div className="book-toc-group">{item.title}</div>}
    </li>)}</ol>
    {filteredToc.length === 0 && <p className="px-7 py-10 text-center font-sans text-xs text-muted">没有匹配的目录项</p>}
  </div>;

  return <ReadingBookshelfContext.Provider value={{
    available: bookshelfEnabled,
    added: onBookshelf,
    busy: bookshelfBusy,
    toggle: () => void toggleBookshelf(),
    speechLauncherTarget,
    getSpeechPosition,
    showSpeechLocation,
    chromeHidden: mobileChromeHidden || readerOverlayOpen,
  }}><div data-reader-chrome-hidden={mobileChromeHidden || undefined} className={`book-reader book-reader-root h-screen overflow-hidden ${isDark ? "book-reader-dark" : ""} ${shellClass}`}>
    <nav {...chromeProps} data-book-toolbar data-reader-mobile-toolbar={mobileViewport || undefined} aria-label="阅读工具" className={`${mobileViewport ? "book-mobile-toolbar grid-cols-5 border-t" : "book-desktop-toolbar fixed right-5 top-1/2 -translate-y-1/2"} z-30 ${chromeClass}`}>
      <button type="button" onClick={() => tocOpen ? setTocOpen(false) : openPanel("toc")} className="book-mobile-tool" aria-label="打开目录" aria-pressed={tocOpen || searchOpen}><ReaderToolIcon name="toc" /><span>目录</span></button>
      <button type="button" onClick={() => aiOpen ? closeAiPanel() : openBookAi()} className="book-mobile-tool" aria-label="打开书内 AI" aria-pressed={aiOpen}><ReaderToolIcon name="ai" /><span>AI</span></button>
      <button type="button" onClick={() => openTool("progress")} className="book-mobile-tool" aria-label="阅读进度" aria-pressed={toolPopover === "progress"}><ReaderToolIcon name="progress" /><span>进度</span></button>
      <button type="button" onClick={() => openTool("notes")} className="book-mobile-tool" aria-label="阅读笔记" aria-pressed={toolPopover === "notes"}><IoCreateOutline aria-hidden="true" /><span>笔记</span></button>
      <button type="button" onClick={() => openTool("display")} className="book-mobile-tool" aria-label="文字设置" aria-pressed={toolPopover === "display"}><ReaderToolIcon name="display" /><span>文字</span></button>
      {!mobileViewport && speechEnabled && speechControl && <div ref={setSpeechLauncherTarget} className="book-desktop-speech shrink-0" />}
      {!mobileViewport && onDownload && <button type="button" onClick={onDownload} className="book-mobile-tool" aria-label="下载整本 EPUB"><IoDownloadOutline aria-hidden="true" /><span>下载</span></button>}
    </nav>
    {speechEnabled && speechControl}

    {(tocOpen || searchOpen) && <BookNavigationSheet mobile={mobileViewport} tab={tocOpen ? "toc" : "search"} onTabChange={openPanel} onClose={() => { setTocOpen(false); setSearchOpen(false); }} panelClass={panelClass}>
      {tocOpen ? <><div className="book-toc-book-title"><strong>{bookTitle}</strong><span>{logicalChapterCount ? `${logicalChapterCount} 章 · ` : ""}{characterCount.toLocaleString()} 字</span></div><label className="book-toc-filter"><input value={tocQuery} onChange={(event) => setTocQuery(event.target.value)} placeholder="筛选目录" aria-label="搜索目录" className="book-toc-search" /></label>{tocList}</> : <BookSearchPanel embedded bookTitle={bookTitle} panelClass={panelClass} onClose={() => setSearchOpen(false)} onJump={locateSearchResult} onSearch={onSearch} />}
    </BookNavigationSheet>}

    {agentAccess && aiOpen && <BookNavigationSheet mobile={mobileViewport} title="书内 AI" label="AI面板" onClose={closeAiPanel} panelClass={panelClass}><BookAiPanel embedded key={`${aiQuestion || "book-ai"}:${aiInitialAnswer || ""}`} bookTitle={bookTitle} datasetId={datasetId} itemId={itemId} manifestObject={manifestObject} initialQuestion={aiQuestion} initialAnswer={aiInitialAnswer} initialReferences={aiInitialReferences} preparing={aiPreparing} explanationQuote={aiExplanationQuote} focus={aiFocus} panelClass={panelClass} onClose={closeAiPanel} onExplanationComplete={(quote: string, answer: string, references?: RagReference[], metadata?: RagAnswerMetadata) => {
      if (quote.length <= 2_000) void saveExplanation({ datasetId, itemId, chapterId: aiFocus?.chapterId ?? activeChapterId, quote, prefix: aiFocus?.prefix, suffix: aiFocus?.suffix, answer, references, metadata }).catch(() => undefined);
    }} /></BookNavigationSheet>}

    {activeAnnotation && currentUserId ? <AnnotationDiscussionPanel key={activeAnnotation.id}
      thread={activeAnnotation}
      currentUserId={currentUserId}
      onClose={() => setActiveAnnotationId(undefined)}
      onComment={(body, parentCommentId, visibility) => annotations.comment(activeAnnotation.id, body, parentCommentId, visibility)}
      onReport={(commentId, reason, details) => annotations.report(activeAnnotation.id, commentId, reason, details)}
    /> : null}

    {toolPopover && <BookNavigationSheet mobile={mobileViewport} key={toolPopover} compact={toolPopover !== "notes"} title={toolPopover === "progress" ? "阅读进度" : toolPopover === "notes" ? "阅读笔记" : "文字设置"} label={toolPopover === "progress" ? "阅读进度面板" : toolPopover === "notes" ? "阅读笔记面板" : "文字设置面板"} onClose={() => { setToolPopover(undefined); setProgressPreview(undefined); }} panelClass={panelClass}>
      <div className="book-tool-sheet-body">
        {toolPopover === "progress" ? <div>
          <div className="book-progress-stats">
            <div><strong>{bookProgress}<small>%</small></strong><span>{remainingMinutes ? `约${formatReadingTime(remainingMinutes * 60)}后读完` : "已读完"}</span></div>
            <div><strong className="book-progress-duration">{formatReadingTime(readingSeconds)}</strong><span>阅读时长</span></div>
            <button type="button" onClick={() => openTool("notes")}><strong>{bookNotes.length}<small>条</small></strong><span>笔记</span></button>
          </div>
          <div className="book-progress-preview" aria-live="polite"><strong>{chapters.find((chapter) => chapter.id === previewLocation?.chapterId)?.title || "正文"}</strong><span>{(progressPreview ?? bookProgress).toFixed(1)}%</span></div>
          <div className="book-progress-rail"><button type="button" aria-label="上一章" disabled={!previousChapter} onClick={() => chooseChapter(previousChapter?.id)}>‹</button><input type="range" min="0" max="100" step="0.1" value={progressPreview ?? exactBookProgress} onChange={(event) => setProgressPreview(+event.target.value)} onPointerUp={(event) => commitBookProgress(+event.currentTarget.value)} onKeyUp={(event) => { if (RANGE_KEYS.includes(event.key)) commitBookProgress(+event.currentTarget.value); }} onBlur={(event) => { if (progressPreview !== undefined) commitBookProgress(+event.currentTarget.value); }} onPointerCancel={() => setProgressPreview(undefined)} style={rangeFill(progressPreview ?? exactBookProgress)} className="reader-range book-reader-range" aria-label="全书进度" aria-valuetext={`${(progressPreview ?? bookProgress).toFixed(1)}%，${chapters.find((chapter) => chapter.id === previewLocation?.chapterId)?.title || "正文"}`} /><button type="button" aria-label="下一章" disabled={!nextChapter} onClick={() => chooseChapter(nextChapter?.id)}>›</button></div>
          <div className="book-progress-endpoints"><span>全书开头</span><span>全书结尾</span></div>
        </div> : toolPopover === "notes" ? <div className="book-notes-list">
          {!annotationAccess ? <p>登录后可查看和保存阅读笔记。</p> : <>
            {notesError && <div className="book-notes-error" role="alert"><p>{notesError}</p><button type="button" onClick={() => setNotesRevision((revision) => revision + 1)}>重试</button></div>}
            {notesLoading && <p role="status">正在读取笔记…</p>}
            {!notesLoading && !notesError && !bookNotes.length && <p>还没有笔记。选中正文，可以划线或写下想法。</p>}
            {bookNotes.map((note) => <button type="button" key={note.id} onClick={() => { setToolPopover(undefined); onLocate(note.sectionId, note.quote); }}><span>{chapters.find((chapter) => chapter.id === note.sectionId)?.title || "正文"}</span><blockquote>{note.quote}</blockquote>{note.comments.filter((comment) => comment.authorId === currentUserId).map((comment) => <p key={comment.id}>{comment.body}</p>)}</button>)}
          </>}
        </div> : <div className="space-y-5 pb-1">
          <div>
            <div className="mb-2 flex items-center justify-between font-sans text-xs text-muted"><span>字号</span><span className="font-serif text-base text-current">{fontSize}px</span></div>
            <div className="grid grid-cols-[24px_1fr_28px] items-center gap-3"><span className="font-serif text-sm">A</span><input type="range" min="14" max="24" value={fontSize} onChange={(event) => setFontSize(+event.target.value)} onPointerUp={() => setToolPopover(undefined)} onKeyUp={(event) => { if (RANGE_KEYS.includes(event.key)) setToolPopover(undefined); }} style={rangeFill((fontSize - 14) * 10)} className="reader-range book-reader-range w-full" aria-label="字号" /><span className="font-serif text-2xl">A</span></div>
          </div>
          <div>
            <p className="mb-2 mt-0 font-sans text-xs text-muted">纸张颜色</p>
            <div className="grid grid-cols-3 gap-2">{(["ivory", "white", "dark"] as BookReaderPaperColor[]).map((value) => <button type="button" key={value} aria-pressed={paperColor === value} onClick={() => { setPaperColor(value); setToolPopover(undefined); }} className={`book-paper-choice h-14 border font-sans text-xs ${value === "ivory" ? "bg-[#fbfaf6] text-ink" : value === "white" ? "bg-white text-ink" : "bg-[#202321] text-white"} ${paperColor === value ? "border-red is-active" : "border-rule"}`}>{value === "ivory" ? "米白" : value === "white" ? "纯白" : "夜间"}</button>)}</div>
          </div>
          <div className="grid grid-cols-2 gap-2 font-sans text-xs">
            <button type="button" aria-label="纸张纹理" aria-pressed={paperTexture} onClick={() => { setPaperTexture((value) => !value); setToolPopover(undefined); }} className={`book-setting-choice ${paperTexture ? "is-active" : ""}`}><span>纸张纹理</span><strong>{paperTexture ? "开" : "关"}</strong></button>
            <div className="grid grid-cols-2 border border-rule p-1">
              <button type="button" aria-pressed={mode === "paged"} onClick={() => { changeMode("paged"); setToolPopover(undefined); }} className={`border-0 px-1 py-3 ${mode === "paged" ? "bg-red text-white" : "bg-transparent text-current"}`}>翻页</button>
              <button type="button" aria-pressed={mode === "scroll"} onClick={() => { changeMode("scroll"); setToolPopover(undefined); }} className={`border-0 px-1 py-3 ${mode === "scroll" ? "bg-red text-white" : "bg-transparent text-current"}`}>滚动</button>
            </div>
          </div>
        </div>}
      </div>
    </BookNavigationSheet>}

    {textSelection && <ReaderSelectionPopover rect={textSelection.rect} width={annotationAccess ? 288 : 144}>
      <div className="book-selection-actions" role="toolbar" aria-label="选中文字工具">
        <button type="button" onClick={() => void copySelection()} className="reader-selection-action"><IoCopyOutline aria-hidden="true" /><span>复制</span></button>
        {annotationAccess && <><button type="button" disabled={annotationSaving} onClick={() => void underlineSelection()} className="reader-selection-action"><span aria-hidden="true" className="book-selection-underline">A</span><span>划线</span></button>
        <button type="button" disabled={annotationSaving} onClick={composeThought} className="reader-selection-action"><IoCreateOutline aria-hidden="true" /><span>写想法</span></button></>}
        <button type="button" onClick={() => agentAccess ? void explainSelection() : openBookAi()} className="reader-selection-action" aria-label="AI 解释"><IoSparklesOutline aria-hidden="true" /><span>AI 解释</span></button>
      </div>
    </ReaderSelectionPopover>}

    {thoughtSelection && <BookThoughtComposer quote={thoughtSelection.text} value={thought} visibility={thoughtVisibility}
      saving={annotationSaving} error={thoughtError} panelClass={panelClass} onChange={setThought} onVisibilityChange={setThoughtVisibility}
      onSave={() => void saveThought()} onClose={clearSelection} />}

    {readerNotice && <button type="button" onClick={() => setReaderNotice("")} className={`fixed bottom-20 left-1/2 z-[66] -translate-x-1/2 border px-4 py-2 font-sans text-xs shadow-lg md:bottom-6 ${panelClass}`}>{readerNotice}</button>}

    <header className={`relative z-20 h-12 border-b backdrop-blur-md ${chromeClass}`}>
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
          <span>{onBookshelf ? "已在书架" : "加入书架"}</span>
        </button>}
        <span className="min-w-0 flex-1" aria-hidden="true" />
        <span className="hidden max-w-[42%] truncate text-muted md:block">{chapters[activeChapterIndex]?.title}</span>
      </div>
    </header>

    {expandedImage && <div role="dialog" aria-modal="true" aria-label="图片预览" onClick={() => setExpandedImage(undefined)} className="fixed inset-0 z-[70] flex items-center justify-center bg-black/85 p-5 md:p-10">
      <button type="button" onClick={() => setExpandedImage(undefined)} className="flex h-full w-full cursor-zoom-out flex-col items-center justify-center gap-3 border-0 bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-white" aria-label="关闭图片预览">
        <img src={expandedImage.src} alt={expandedImage.alt || "放大图片"} className="max-h-[80dvh] max-w-full cursor-zoom-out object-contain" />
        {expandedImage.alt && expandedImage.alt !== "正文图片" && <span className="font-sans text-xs text-white/75">{expandedImage.alt}</span>}
      </button>
    </div>}

    {mode === "scroll" ? <div ref={scrollRef} data-book-reading-surface onScroll={updateScrollProgress} onClick={handleReaderClick} onPointerDown={startReaderTap} onPointerMove={moveReaderTap} onPointerCancel={cancelReaderTap} onPointerUp={finishReaderPointer} onKeyUp={captureTextSelection} className="book-scroll-surface h-[calc(100%-48px)] overflow-y-auto">
      <main className="mx-auto max-w-[920px] px-0 py-0 md:px-5 md:py-8">
        <article className={`relative min-h-full border-0 px-6 pb-32 pt-10 shadow-none sm:px-12 md:min-h-[calc(100vh-96px)] md:border-x md:px-20 md:py-20 md:shadow-[0_16px_50px_rgba(32,32,28,.10)] ${pageClass} ${paperTexture ? "book-page-texture" : ""} ${isDark ? "md:border-[#2d312e]" : "md:border-[#ddddd6]"}`} style={{ fontSize: `${fontSize}px`, lineHeight: 2.05 }}>
          <div className="mx-auto max-w-[730px]">{error && <p className="border-l-4 border-red bg-red/5 px-4 py-3 text-sm text-red">{error}</p>}<>{loadChapter ? <ContinuousBookContent key={`${datasetId}:${itemId}:${currentUserId ?? "guest"}`} ref={continuousRef} chapters={chapters} initialChapterId={activeChapterId} loadChapter={loadChapter} scrollRef={scrollRef} onPosition={continuousPosition} onReady={continuousContentReady} /> : <div data-speech-content>{children}</div>}</></div>
        </article>
      </main>
    </div> : <main className="relative h-[calc(100%-48px)] px-0 py-0 md:px-20 md:py-6">
      <div className="relative mx-auto h-full max-w-[1180px]">
        <article onClick={handleReaderClick} onPointerDown={startReaderTap} onPointerMove={moveReaderTap} onPointerCancel={cancelReaderTap} onPointerUp={finishReaderPointer} onKeyUp={captureTextSelection} className={`relative h-full overflow-hidden border-0 px-6 pb-32 pt-10 shadow-none sm:px-10 md:border md:px-16 md:py-14 md:shadow-[0_16px_55px_rgba(32,32,28,.14)] ${pageClass} ${paperTexture ? "book-page-texture" : ""} ${isDark ? "md:border-[#2d312e]" : "md:border-[#d8d8d1]"}`}>
          {columnsPerSpread === 2 && <div className={`pointer-events-none absolute inset-y-0 left-1/2 z-10 w-10 -translate-x-1/2 ${isDark ? "bg-[linear-gradient(90deg,transparent,rgba(0,0,0,.22),transparent)]" : "bg-[linear-gradient(90deg,transparent,rgba(77,75,66,.09),transparent)]"}`} aria-hidden="true" />}
          <div ref={flowRef} data-book-page-flow data-book-reading-surface className={`relative h-full overflow-hidden [column-fill:auto] [&_img]:cursor-zoom-in [&_figure]:break-inside-avoid [&_h1]:[break-after:avoid-column] [&_h2]:[break-after:avoid-column] [&_li]:break-inside-avoid `} style={{ touchAction: "pan-y", columnCount: columnsPerSpread, columnGap: columnsPerSpread === 2 ? "80px" : "48px", fontSize: `${fontSize}px`, lineHeight: 1.95 }}>
            {error && <p className="border-l-4 border-red bg-red/5 px-4 py-3 text-sm text-red">{error}</p>}<div data-speech-content style={{ display: "contents" }}>{children}</div>
            {trailingBlankPage && <span data-book-trailing-page className="book-page-trailing-blank" aria-hidden="true" />}
          </div>
        </article>
        {!mobileViewport && <>
        <button {...chromeProps} type="button" onClick={previousPage} disabled={contentLoading || (!previousChapter && pageMetrics.page === 0)} className={`book-page-turn-control absolute left-5 z-30 flex h-10 items-center justify-center gap-1 border px-3 font-sans text-xs shadow-[2px_4px_14px_rgba(0,0,0,.08)] cursor-pointer transition-colors disabled:cursor-default disabled:opacity-20 sm:left-8 ${panelClass}`} aria-label="上一页" title="上一页（←）"><span aria-hidden="true">‹</span> 上一页</button>
        <button {...chromeProps} type="button" onClick={nextPage} disabled={contentLoading || (!nextChapter && pageMetrics.page >= pageMetrics.spreads - 1)} className={`book-page-turn-control absolute right-5 z-30 flex h-10 items-center justify-center gap-1 border px-3 font-sans text-xs shadow-[2px_4px_14px_rgba(0,0,0,.08)] cursor-pointer transition-colors disabled:cursor-default disabled:opacity-20 sm:right-8 ${panelClass}`} aria-label="下一页" title="下一页（→ 或空格）">下一页 <span aria-hidden="true">›</span></button>
        </>}
      </div>
      <div {...chromeProps} className="book-page-number pointer-events-none absolute inset-x-0 flex items-center justify-center gap-4 font-sans text-[10px] text-muted">
        <span>{firstPhysicalPage === lastPhysicalPage ? firstPhysicalPage : `${firstPhysicalPage}–${lastPhysicalPage}`} / {pageMetrics.physicalPages} 页</span>
      </div>
    </main>}
  </div></ReadingBookshelfContext.Provider>;
}
