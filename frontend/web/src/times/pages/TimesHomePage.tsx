import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { TimesTimelineIndex } from "@jojo/content";
import { timesApi, type TimesNewsItem } from "../api";
import { SourceLogo } from "../components/SourceLogo";
import { TimelineArticle } from "../components/TimelineArticle";
import {
  hydrateTimesReadState,
  useTimesReadStore,
} from "../readStore";
import { timesSourceName } from "../sourceNames";
import { TimesDetailPage } from "./TimesDetailPage";

export function TimesHomePage() {
  const navigate = useNavigate();
  const { issueDate = "", newsId = "" } = useParams();
  const [index, setIndex] = useState<TimesTimelineIndex | null>(null);
  const [days, setDays] = useState<Array<{ date: string; articles: TimesNewsItem[] }>>([]);
  const [selectedSource, setSelectedSource] = useState("all");
  const [nextDay, setNextDay] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const listViewport = useRef<HTMLDivElement | null>(null);
  const readById = useTimesReadStore((state) => state.readById);

  const loadMore = useCallback(async () => {
    if (!index || loadingMore || nextDay >= index.dates.length) return;
    setLoadingMore(true);
    const ref = index.dates[nextDay];
    try {
      if (!ref) return;
      const day = await timesApi.timelineDay(ref.date);
      setDays((current) => current.some((value) => value.date === day.date)
        ? current
        : [...current, { date: day.date, articles: day.articles }]);
      setNextDay((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "时间线加载失败");
    } finally {
      setLoadingMore(false);
    }
  }, [index, loadingMore, nextDay]);

  useEffect(() => {
    let active = true;
    void timesApi.timelineIndex().then(async (value) => {
      if (!active) return;
      setIndex(value);
      const first = value.dates[0];
      if (first) {
        const day = await timesApi.timelineDay(first.date);
        if (active) {
          setDays([{ date: day.date, articles: day.articles }]);
          setNextDay(1);
        }
      }
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "时事数据暂时不可用");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !index) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, { root: listViewport.current, rootMargin: "500px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [index, loadMore]);

  const loadedArticleIds = useMemo(
    () => days.flatMap((day) => day.articles.map((article) => article.id)),
    [days],
  );
  useEffect(() => {
    hydrateTimesReadState(loadedArticleIds);
  }, [loadedArticleIds]);

  const visibleDays = useMemo(() => days.map((day) => ({
    ...day,
    articles: selectedSource === "all"
      ? day.articles
      : day.articles.filter((article) => article.source.id === selectedSource),
  })).filter((day) => day.articles.length), [days, selectedSource]);

  const firstVisibleArticle = visibleDays[0]?.articles[0];
  const activeIssueDate = issueDate || firstVisibleArticle?.issueDate || "";
  const activeNewsId = newsId || firstVisibleArticle?.id || "";
  const showingMobileDetail = Boolean(issueDate && newsId);
  const selectedSourceItem = selectedSource === "all"
    ? undefined
    : index?.sources.find((source) => source.id === selectedSource);
  const selectedSourceName = selectedSourceItem ? timesSourceName(selectedSourceItem) : "时事";

  function chooseSource(sourceId: string) {
    setSelectedSource(sourceId);
    navigate("/times", { replace: true });
  }

  return (
    <main className="h-[calc(100vh-64px)] overflow-hidden bg-[var(--app-canvas)] text-ink lg:grid lg:grid-cols-[220px_390px_minmax(0,1fr)] xl:grid-cols-[240px_450px_minmax(0,1fr)]">
      <aside aria-label="媒体来源" className="hidden min-h-0 flex-col border-r border-rule bg-[var(--app-canvas)] lg:flex">
        <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-4" aria-label="选择媒体">
          <p className="px-2 pb-2 font-sans text-[10px] font-black tracking-[0.16em] text-muted">媒体来源</p>
          <button type="button" onClick={() => chooseSource("all")} className={`flex w-full items-center gap-2.5 border-l-2 px-3 py-1.5 text-left font-sans text-sm font-bold ${selectedSource === "all" ? "border-red bg-paper text-red" : "border-transparent hover:bg-paper"}`}>
            <span aria-hidden="true" className="grid h-6 w-6 shrink-0 place-content-center bg-red">
              <span className="grid grid-cols-2 gap-[2px]">
                <i className="h-1 w-1 bg-paper" /><i className="h-1 w-1 bg-paper" />
                <i className="h-1 w-1 bg-paper" /><i className="h-1 w-1 bg-paper" />
              </span>
            </span>
            <span>所有媒体</span>
          </button>
          {index?.sources.map((source) => {
            return (
              <button key={source.id} type="button" onClick={() => chooseSource(source.id)} className={`flex w-full items-center gap-2.5 border-l-2 px-3 py-1.5 text-left font-sans text-sm ${selectedSource === source.id ? "border-red bg-paper font-bold text-red" : "border-transparent hover:bg-paper"}`}>
                <SourceLogo source={source} size="rail" />
                <span className="min-w-0 truncate">{timesSourceName(source)}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <section className={`${showingMobileDetail ? "hidden lg:flex" : "flex"} min-h-0 flex-col border-r border-rule bg-paper`} aria-label="文章列表">
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-ink px-4 sm:px-5">
          {selectedSource !== "all" && firstVisibleArticle ? <SourceLogo article={firstVisibleArticle} size="header" /> : null}
          <h1 className="truncate text-base font-black leading-tight">{selectedSourceName}</h1>
        </header>
        <div ref={listViewport} className="min-h-0 flex-1 overflow-y-auto">
          {loading ? <p className="px-5 py-10 font-sans text-sm text-muted">正在加载新闻…</p> : null}
          {error ? <div role="alert" className="m-5 border-2 border-red bg-paper p-5 font-sans text-sm text-red">{error}</div> : null}
          {visibleDays.flatMap((day) => day.articles).map((article) => (
            <TimelineArticle
              key={article.id}
              article={article}
              active={article.issueDate === activeIssueDate && article.id === activeNewsId}
              read={Boolean(readById[article.id])}
            />
          ))}
          {!loading && !visibleDays.length && !error ? <p className="px-5 py-16 text-center text-lg font-black">暂无文章</p> : null}
          <div ref={sentinel} className="flex h-20 items-center justify-center font-sans text-xs text-muted">
            {loadingMore ? "正在加载更早的日期…" : index && nextDay >= index.dates.length ? "已到达时间线起点" : ""}
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
    </main>
  );
}
