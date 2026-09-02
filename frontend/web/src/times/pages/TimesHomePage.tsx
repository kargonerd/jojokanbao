import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { TimesTimelineIndex, TimesTimelinePage } from "@jojo/content";
import { timesApi, timesTimelinePageCount } from "../api";
import { SourceLogo } from "../components/SourceLogo";
import { TimelineArticle } from "../components/TimelineArticle";
import { ReadingLoadingState } from "../../reading/ReadingLoadingState";
import { presentTimesArticle } from "../language";
import { useTimesPreferencesStore } from "../preferencesStore";
import {
  hydrateTimesReadState,
  useTimesReadStore,
} from "../readStore";
import { timesSourceName } from "../sourceNames";
import { TimesDetailPage } from "./TimesDetailPage";

function AllSourcesIcon({ className }: { className: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={`${className} shrink-0 text-red`} fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3.75 3.75h6.5v6.5h-6.5zM13.75 3.75h6.5v6.5h-6.5zM3.75 13.75h6.5v6.5h-6.5zM13.75 13.75h6.5v6.5h-6.5z" />
    </svg>
  );
}

type TimelineCursor = { dateIndex: number; page: number };

function firstTimelineCursor(index: TimesTimelineIndex): TimelineCursor | null {
  const dateIndex = index.dates.findIndex((date) => timesTimelinePageCount(date) > 0);
  return dateIndex >= 0 ? { dateIndex, page: 0 } : null;
}

function nextTimelineCursor(index: TimesTimelineIndex, cursor: TimelineCursor): TimelineCursor | null {
  const current = index.dates[cursor.dateIndex];
  if (current && cursor.page + 1 < timesTimelinePageCount(current)) {
    return { dateIndex: cursor.dateIndex, page: cursor.page + 1 };
  }
  for (let dateIndex = cursor.dateIndex + 1; dateIndex < index.dates.length; dateIndex += 1) {
    const date = index.dates[dateIndex];
    if (date && timesTimelinePageCount(date) > 0) return { dateIndex, page: 0 };
  }
  return null;
}

function RefreshButton({
  refreshing,
  onRefresh,
  compact = false,
}: {
  refreshing: boolean;
  onRefresh(): void;
  compact?: boolean;
}) {
  const tooltipId = useId();
  return (
    <span className="relative flex shrink-0">
      <button
        type="button"
        aria-label="拉取最新新闻"
        aria-describedby={tooltipId}
        aria-busy={refreshing}
        title="拉取最新"
        disabled={refreshing}
        onClick={onRefresh}
        className={`peer group grid shrink-0 place-content-center border border-ink bg-paper text-ink transition-[color,transform,box-shadow] hover:-translate-y-0.5 hover:text-red hover:shadow-[2px_2px_0_var(--color-red)] focus:outline-none focus-visible:ring-2 focus-visible:ring-red disabled:translate-y-0 disabled:cursor-wait disabled:text-muted disabled:shadow-none ${compact ? "h-8 w-8" : "h-7 w-7"}`}
      >
        <svg aria-hidden="true" viewBox="0 0 20 20" className={`h-3.5 w-3.5 ${refreshing ? "motion-safe:animate-spin" : "transition-transform group-hover:-rotate-12"}`} fill="none" stroke="currentColor" strokeWidth="1.7">
          <path d="M16 6.5V2.8l-1.7 1.7A7 7 0 1 0 17 10" />
          <path d="M16 2.8h-3.7" />
        </svg>
      </button>
      <span
        id={tooltipId}
        role="tooltip"
        className="pointer-events-none absolute right-0 top-[calc(100%+6px)] z-30 whitespace-nowrap border border-ink bg-ink px-2 py-1 font-sans text-[11px] font-bold text-paper opacity-0 transition-opacity peer-hover:opacity-100 peer-focus-visible:opacity-100"
      >
        拉取最新
      </span>
    </span>
  );
}

export function TimesHomePage() {
  const navigate = useNavigate();
  const { issueDate = "", newsId = "" } = useParams();
  const [index, setIndex] = useState<TimesTimelineIndex | null>(null);
  const [pages, setPages] = useState<TimesTimelinePage[]>([]);
  const [nextCursor, setNextCursor] = useState<TimelineCursor | null>(null);
  const [selectedSource, setSelectedSource] = useState("all");
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshStatus, setRefreshStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const listViewport = useRef<HTMLDivElement | null>(null);
  const sourceRail = useRef<HTMLElement | null>(null);
  const timelineGeneration = useRef(0);
  const loadingMoreRef = useRef(false);
  const refreshingRef = useRef(false);
  const [sourceRailHasMore, setSourceRailHasMore] = useState(false);
  const readById = useTimesReadStore((state) => state.readById);
  const languagePreference = useTimesPreferencesStore((state) => state.foreignContentLanguage);
  const disabledSourceIds = useTimesPreferencesStore((state) => state.disabledSourceIds);
  const disabledSources = useMemo(() => new Set(disabledSourceIds), [disabledSourceIds]);

  useEffect(() => {
    let active = true;
    const generation = ++timelineGeneration.current;
    void timesApi.timelineIndex().then(async (value) => {
      if (!active || generation !== timelineGeneration.current) return;
      const first = firstTimelineCursor(value);
      const firstDate = first ? value.dates[first.dateIndex] : undefined;
      if (first && firstDate) {
        const firstPage = await timesApi.timelinePage(firstDate.date, first.page);
        if (active && generation === timelineGeneration.current) {
          setIndex(value);
          setPages([firstPage]);
          setNextCursor(nextTimelineCursor(value, first));
        }
      } else {
        setIndex(value);
      }
    }).catch((reason: unknown) => {
      if (active && generation === timelineGeneration.current) {
        setError(reason instanceof Error ? reason.message : "时事数据暂时不可用");
      }
    }).finally(() => {
      if (active && generation === timelineGeneration.current) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  const loadMore = useCallback(async () => {
    const target = nextCursor;
    if (!index || !target || loadMoreFailed || loadingMoreRef.current || refreshingRef.current) return;
    const date = index.dates[target.dateIndex];
    if (!date) return;
    const generation = timelineGeneration.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setError(null);
    try {
      const value = await timesApi.timelinePage(date.date, target.page);
      if (generation !== timelineGeneration.current) return;
      setPages((current) => current.some((page) => page.date === value.date && page.page === value.page)
        ? current
        : [...current, value]);
      setNextCursor(nextTimelineCursor(index, target));
    } catch (reason) {
      if (generation === timelineGeneration.current) {
        setError(reason instanceof Error ? reason.message : "时间线加载失败");
        setLoadMoreFailed(true);
      }
    } finally {
      if (generation === timelineGeneration.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [index, loadMoreFailed, nextCursor]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !index || !nextCursor || loadMoreFailed) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, { root: listViewport.current, rootMargin: "500px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [disabledSources, index, loadMore, loadingMore, loadMoreFailed, nextCursor, refreshing, selectedSource]);

  const refreshLatest = useCallback(async () => {
    if (refreshingRef.current) return;
    const generation = ++timelineGeneration.current;
    refreshingRef.current = true;
    loadingMoreRef.current = true;
    setRefreshing(true);
    setLoadingMore(false);
    setLoadMoreFailed(false);
    setRefreshStatus("");
    setError(null);
    try {
      const value = await timesApi.timelineIndex(true);
      const first = firstTimelineCursor(value);
      const firstDate = first ? value.dates[first.dateIndex] : undefined;
      const firstPage = first && firstDate
        ? await timesApi.timelinePage(firstDate.date, first.page, true)
        : null;
      if (generation !== timelineGeneration.current) return;
      setIndex(value);
      setPages(firstPage ? [firstPage] : []);
      setNextCursor(first ? nextTimelineCursor(value, first) : null);
      if (listViewport.current) listViewport.current.scrollTop = 0;
      setRefreshStatus(firstPage ? "已拉取最新新闻" : "当前没有新闻");
    } catch (reason) {
      if (generation === timelineGeneration.current) {
        setError(reason instanceof Error ? reason.message : "最新新闻拉取失败");
        setRefreshStatus("拉取失败");
      }
    } finally {
      if (generation === timelineGeneration.current) {
        refreshingRef.current = false;
        loadingMoreRef.current = false;
        setRefreshing(false);
      }
    }
  }, []);

  const loadedArticleIds = useMemo(
    () => pages.flatMap((page) => page.articles.map((article) => article.id)),
    [pages],
  );
  useEffect(() => {
    hydrateTimesReadState(loadedArticleIds);
  }, [loadedArticleIds]);

  const visibleArticles = useMemo(() => pages.flatMap((page) => page.articles)
      .filter((article) => !disabledSources.has(article.source.id))
      .filter((article) => selectedSource === "all" || article.source.id === selectedSource)
      .map((article) => presentTimesArticle(article, languagePreference)),
  [pages, disabledSources, languagePreference, selectedSource]);

  const firstVisibleArticle = visibleArticles[0];
  const activeIssueDate = issueDate || firstVisibleArticle?.issueDate || "";
  const activeNewsId = newsId || firstVisibleArticle?.id || "";
  const showingMobileDetail = Boolean(issueDate && newsId);
  const selectedSourceItem = selectedSource === "all"
    ? undefined
    : index?.sources.find((source) => source.id === selectedSource);
  const selectedSourceName = selectedSourceItem ? timesSourceName(selectedSourceItem) : "时事";

  const updateSourceRailOverflow = useCallback(() => {
    const node = sourceRail.current;
    setSourceRailHasMore(Boolean(node && node.scrollHeight - node.scrollTop - node.clientHeight > 2));
  }, []);

  const scrollSourceRailForward = useCallback(() => {
    const node = sourceRail.current;
    if (!node) return;
    node.scrollBy({ top: Math.max(160, node.clientHeight * 0.7), behavior: "smooth" });
  }, []);

  useEffect(() => {
    updateSourceRailOverflow();
    window.addEventListener("resize", updateSourceRailOverflow);
    return () => window.removeEventListener("resize", updateSourceRailOverflow);
  }, [disabledSources, index, updateSourceRailOverflow]);

  useEffect(() => {
    if (selectedSource !== "all" && disabledSources.has(selectedSource)) {
      setSelectedSource("all");
      navigate("/times", { replace: true });
    }
  }, [disabledSources, navigate, selectedSource]);

  useEffect(() => {
    setLoadMoreFailed(false);
  }, [disabledSourceIds, selectedSource]);

  function chooseSource(sourceId: string) {
    setSelectedSource(sourceId);
    setSourcePickerOpen(false);
    if (listViewport.current) listViewport.current.scrollTop = 0;
    navigate("/times", { replace: true });
  }

  return (
    <main className={`${showingMobileDetail ? "min-h-[calc(100dvh-58px)] overflow-visible" : "h-[calc(100dvh-58px)] overflow-hidden"} bg-[var(--app-canvas)] text-ink lg:grid lg:h-[calc(100vh-64px)] lg:min-h-0 lg:grid-cols-[220px_390px_minmax(0,1fr)] lg:overflow-hidden xl:grid-cols-[240px_450px_minmax(0,1fr)]`}>
      <aside aria-label="媒体来源" className="hidden min-h-0 flex-col border-r border-rule bg-[var(--app-canvas)] lg:flex">
        <div className="relative min-h-0 flex-1">
          <nav ref={sourceRail} onScroll={updateSourceRailOverflow} className="times-source-scroller h-full overflow-y-auto overscroll-contain px-3 py-4" aria-label="选择媒体">
            <p className="px-2 pb-2 font-sans text-[10px] font-black tracking-[0.16em] text-muted">媒体来源</p>
            <button type="button" onClick={() => chooseSource("all")} className={`flex w-full items-center gap-2.5 border-l-2 px-3 py-1.5 text-left font-sans text-sm font-bold ${selectedSource === "all" ? "border-red bg-paper text-red" : "border-transparent hover:bg-paper"}`}>
              <AllSourcesIcon className="h-6 w-6" />
              <span>所有媒体</span>
            </button>
            {index?.sources.filter((source) => !disabledSources.has(source.id)).map((source) => {
              return (
                <button key={source.id} type="button" onClick={() => chooseSource(source.id)} className={`flex w-full items-center gap-2.5 border-l-2 px-3 py-1.5 text-left font-sans text-sm ${selectedSource === source.id ? "border-red bg-paper font-bold text-red" : "border-transparent hover:bg-paper"}`}>
                  <SourceLogo source={source} size="rail" />
                  <span className="min-w-0 truncate">{timesSourceName(source)}</span>
                </button>
              );
            })}
          </nav>
          {sourceRailHasMore ? (
            <button type="button" onClick={scrollSourceRailForward} className="times-source-overflow-hint" aria-label="向下查看更多媒体">
              <span>向下查看更多媒体</span>
              <svg aria-hidden="true" viewBox="0 0 16 16" fill="none">
                <path d="m3.5 6 4.5 4 4.5-4" />
              </svg>
            </button>
          ) : null}
        </div>
      </aside>

      <section className={`${showingMobileDetail ? "hidden lg:flex" : "flex"} h-full min-h-0 flex-col border-r border-rule bg-paper`} aria-label="文章列表">
        <header className="hidden h-10 shrink-0 items-center gap-2 border-b border-ink px-5 lg:flex">
          {selectedSource !== "all" && firstVisibleArticle ? <SourceLogo article={firstVisibleArticle} size="header" /> : null}
          <h1 className="min-w-0 flex-1 truncate text-base font-black leading-tight">{selectedSourceName}</h1>
          <RefreshButton refreshing={refreshing} onRefresh={() => void refreshLatest()} />
        </header>
        <div className="flex h-11 w-full shrink-0 border-b border-ink bg-paper font-sans lg:hidden">
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={sourcePickerOpen}
            aria-label={`筛选媒体，当前：${selectedSource === "all" ? "所有媒体" : selectedSourceName}`}
            onClick={() => setSourcePickerOpen(true)}
            className="flex min-w-0 flex-1 items-center gap-3 px-4 text-left"
          >
            {selectedSource !== "all" && firstVisibleArticle ? <SourceLogo article={firstVisibleArticle} size="header" /> : (
              <AllSourcesIcon className="h-6 w-6" />
            )}
            <span className="min-w-0 flex-1 truncate text-sm font-black text-ink">
              {selectedSource === "all" ? "所有媒体" : selectedSourceName}
            </span>
            <span className="flex shrink-0 items-center gap-1 text-xs font-bold text-red">
              筛选<span aria-hidden="true">⌄</span>
            </span>
          </button>
          <div className="flex shrink-0 items-center border-l border-rule px-2">
            <RefreshButton compact refreshing={refreshing} onRefresh={() => void refreshLatest()} />
          </div>
        </div>
        <div ref={listViewport} className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
          <p className="sr-only" aria-live="polite">{refreshStatus}</p>
          {loading ? <ReadingLoadingState kind="times" status="正在加载新闻…" /> : null}
          {error ? <div role="alert" className="m-5 border-2 border-red bg-paper p-5 font-sans text-sm text-red">{error}</div> : null}
          {visibleArticles.map((article) => (
            <TimelineArticle
              key={article.id}
              article={article}
              active={article.issueDate === activeIssueDate && article.id === activeNewsId}
              read={Boolean(readById[article.id])}
            />
          ))}
          {!loading && !visibleArticles.length && !error ? (
            <p className="px-5 py-16 text-center text-lg font-black">
              {pages.length ? "已加载范围内没有该媒体的文章" : "暂无文章"}
            </p>
          ) : null}
          <div ref={sentinel} className="flex min-h-20 items-center justify-center border-t border-rule px-4 font-sans text-xs text-muted">
            {loadingMore ? "正在加载更早的新闻…" : index && !nextCursor ? "已到达时间线起点" : ""}
          </div>
        </div>
      </section>

      <section className={`${showingMobileDetail ? "flex" : "hidden lg:flex"} min-h-0 flex-col bg-paper`} aria-label="文章正文">
        {activeIssueDate && activeNewsId ? (
          <TimesDetailPage issueDate={activeIssueDate} newsId={activeNewsId} embedded markReadOnOpen={showingMobileDetail} />
        ) : (
          <div className="flex h-full items-center justify-center px-8 text-center text-muted">
            <p className="font-sans text-sm">选择一篇文章开始阅读</p>
          </div>
        )}
      </section>

      {sourcePickerOpen && !showingMobileDetail ? (
        <div className="fixed inset-0 z-[90] lg:hidden">
          <button
            type="button"
            aria-label="关闭媒体筛选"
            className="absolute inset-0 h-full w-full bg-ink/35"
            onClick={() => setSourcePickerOpen(false)}
          />
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="times-source-picker-title"
            className="absolute inset-x-0 bottom-0 flex max-h-[72dvh] flex-col border-t-2 border-red bg-paper shadow-[0_-8px_30px_rgba(32,32,32,0.18)]"
          >
            <header className="flex shrink-0 items-center border-b border-rule px-5 py-4">
              <div className="min-w-0 flex-1">
                <h2 id="times-source-picker-title" className="text-lg font-black">筛选媒体</h2>
                <p className="mt-0.5 truncate font-sans text-xs text-muted">
                  当前：{selectedSource === "all" ? "所有媒体" : selectedSourceName}
                </p>
              </div>
              <button
                type="button"
                aria-label="关闭"
                className="grid h-9 w-9 place-content-center font-sans text-2xl leading-none text-red"
                onClick={() => setSourcePickerOpen(false)}
              >
                ×
              </button>
            </header>
            <div className="min-h-0 overflow-y-auto overscroll-contain px-3 pb-[calc(12px+env(safe-area-inset-bottom))] pt-2">
              <button
                type="button"
                aria-pressed={selectedSource === "all"}
                onClick={() => chooseSource("all")}
                className={`flex w-full items-center gap-3 border-l-2 px-3 py-3 text-left font-sans text-base ${selectedSource === "all" ? "border-red bg-red/[0.06] font-black text-red" : "border-transparent font-bold text-ink"}`}
              >
                <AllSourcesIcon className="h-8 w-8" />
                <span className="min-w-0 flex-1">所有媒体</span>
                {selectedSource === "all" ? <span aria-hidden="true">✓</span> : null}
              </button>
              {index?.sources.filter((source) => !disabledSources.has(source.id)).map((source) => {
                const active = selectedSource === source.id;
                return (
                  <button
                    key={source.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => chooseSource(source.id)}
                    className={`flex w-full items-center gap-3 border-l-2 px-3 py-3 text-left font-sans text-base ${active ? "border-red bg-red/[0.06] font-black text-red" : "border-transparent font-bold text-ink"}`}
                  >
                    <SourceLogo source={source} size="rail" />
                    <span className="min-w-0 flex-1 break-words">{timesSourceName(source)}</span>
                    {active ? <span aria-hidden="true">✓</span> : null}
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
