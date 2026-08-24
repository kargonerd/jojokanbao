import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { timesApi, type TimesDirectory, type TimesNewsItem, type TimesTimelineDay } from "../api";

const categoryLabels: Record<string, string> = {
  world: "国际",
  politics: "政治",
  business: "商业",
  economy: "经济",
  finance: "金融",
  technology: "科技",
  science: "科学",
  culture: "文化",
  society: "社会",
  health: "健康",
  climate: "气候",
  sports: "体育",
};

function formatClock(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "--:--";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function formatDay(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long",
    timeZone: "UTC",
  }).format(date);
}

function formatUpdated(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function primaryCategory(article: TimesNewsItem): string | null {
  return article.categories[0] || article.publisherCategories[0] || null;
}

function categoryLabel(value: string) {
  return categoryLabels[value.toLowerCase()] || value;
}

export function TimesHomePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedSource = searchParams.get("source") || "all";
  const selectedCategory = searchParams.get("category") || "all";
  const [directory, setDirectory] = useState<TimesDirectory | null>(null);
  const [days, setDays] = useState<TimesTimelineDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const loadingMoreRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void timesApi.directory()
      .then(async (nextDirectory) => {
        const firstDate = nextDirectory.dates[0];
        const firstDay = firstDate ? await timesApi.loadDate(firstDate) : null;
        if (!active) return;
        setDirectory(nextDirectory);
        setDays(firstDay ? [firstDay] : []);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "新闻暂时无法加载");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    const refreshLatest = async () => {
      try {
        timesApi.invalidate();
        const nextDirectory = await timesApi.directory();
        const latestDate = nextDirectory.dates[0];
        const latestDay = latestDate ? await timesApi.loadDate(latestDate) : null;
        if (!active) return;
        setDirectory(nextDirectory);
        if (latestDay) {
          setDays((current) => [latestDay, ...current.filter((day) => day.date !== latestDay.date)]
            .sort((left, right) => right.date.localeCompare(left.date)));
        }
      } catch {
        // Keep the already rendered timeline during a background refresh.
      }
    };
    const timer = window.setInterval(() => { void refreshLatest(); }, 10 * 60 * 1000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refreshLatest();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const loadMore = useCallback(async () => {
    if (!directory || loadingMoreRef.current) return;
    const loadedDates = new Set(days.map((day) => day.date));
    const nextDate = directory.dates.find((date) => !loadedDates.has(date));
    if (!nextDate) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const nextDay = await timesApi.loadDate(nextDate);
      setDays((current) => current.some((day) => day.date === nextDay.date) ? current : [...current, nextDay]);
    } catch (reason) {
      setLoadMoreError(reason instanceof Error ? reason.message : "更早的新闻暂时无法加载");
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [days, directory]);

  useEffect(() => {
    const target = sentinelRef.current;
    if (!target || !directory || !directory.dates.some((date) => !days.some((day) => day.date === date))) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, { rootMargin: "320px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [days, directory, loadMore]);

  const categories = useMemo(() => {
    const values = new Set(days.flatMap((day) => day.articles.flatMap((article) => article.categories)));
    return [...values].sort((left, right) => categoryLabel(left).localeCompare(categoryLabel(right), "zh-CN"));
  }, [days]);

  const visibleDays = useMemo(() => days.map((day) => ({
    ...day,
    articles: day.articles.filter((article) => (
      (selectedSource === "all" || article.source.id === selectedSource)
      && (selectedCategory === "all" || article.categories.includes(selectedCategory))
    )),
  })).filter((day) => day.articles.length > 0), [days, selectedCategory, selectedSource]);

  const visibleCount = visibleDays.reduce((sum, day) => sum + day.articles.length, 0);
  const hasMore = Boolean(directory && directory.dates.some((date) => !days.some((day) => day.date === date)));

  function updateFilter(name: "source" | "category", value: string) {
    const next = new URLSearchParams(searchParams);
    if (value === "all") next.delete(name);
    else next.set(name, value);
    setSearchParams(next, { replace: true });
  }

  return (
    <main className="min-h-[calc(100vh-64px)] bg-[var(--app-canvas)] text-ink">
      <header className="border-b border-rule-dark bg-paper">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-5 py-6 md:flex-row md:items-end md:justify-between md:px-8 md:py-8">
          <div>
            <p className="font-sans text-[10px] font-black uppercase tracking-[0.24em] text-red">News wire · 持续更新</p>
            <h1 className="mt-2 text-3xl font-black tracking-[0.08em] md:text-5xl">时事时间线</h1>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-muted">来自全球媒体的完整报道，按发布时间汇入同一条时间线。</p>
          </div>
          <div className="border-l-2 border-red pl-4 font-sans text-[11px] leading-5 text-muted">
            <span className="block font-black text-ink">{directory ? `${directory.publishers.length} 家媒体` : "正在连接新闻源"}</span>
            <span className="block">更新于 {directory ? formatUpdated(directory.updatedAt) : "—"}</span>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-8 px-5 py-6 md:px-8 lg:grid-cols-[210px_minmax(0,780px)] lg:gap-12 lg:py-10">
        <aside className="lg:sticky lg:top-20 lg:self-start">
          <div className="border-b-2 border-ink pb-2 font-sans text-[10px] font-black uppercase tracking-[0.2em] text-red">媒体</div>
          <div className="mt-2 flex gap-2 overflow-x-auto pb-2 lg:block lg:max-h-[calc(100vh-190px)] lg:overflow-y-auto lg:pb-0">
            <button
              type="button"
              onClick={() => updateFilter("source", "all")}
              className={`shrink-0 border-b px-2 py-2 text-left font-sans text-xs font-bold lg:block lg:w-full ${selectedSource === "all" ? "border-red text-red" : "border-rule text-muted hover:border-ink hover:text-ink"}`}
            >
              全部媒体
            </button>
            {directory?.publishers.map((publisher) => (
              <button
                type="button"
                key={publisher.id}
                onClick={() => updateFilter("source", publisher.id)}
                className={`shrink-0 border-b px-2 py-2 text-left font-sans text-xs font-bold lg:block lg:w-full ${selectedSource === publisher.id ? "border-red text-red" : "border-rule text-muted hover:border-ink hover:text-ink"}`}
              >
                {publisher.name}
              </button>
            ))}
          </div>
        </aside>

        <div className="min-w-0">
          <div className="flex gap-2 overflow-x-auto border-b border-rule-dark pb-3 font-sans text-[11px] font-bold">
            <button
              type="button"
              onClick={() => updateFilter("category", "all")}
              className={`shrink-0 px-2 py-1 ${selectedCategory === "all" ? "bg-red text-paper" : "text-muted hover:text-red"}`}
            >
              全部主题
            </button>
            {categories.map((category) => (
              <button
                type="button"
                key={category}
                onClick={() => updateFilter("category", category)}
                className={`shrink-0 px-2 py-1 ${selectedCategory === category ? "bg-red text-paper" : "text-muted hover:text-red"}`}
              >
                {categoryLabel(category)}
              </button>
            ))}
          </div>

          {loading ? <p className="py-16 text-sm text-muted">正在汇入最新报道…</p> : null}
          {error ? <div role="alert" className="my-6 border-l-4 border-red bg-paper px-4 py-3 text-sm text-red">{error}</div> : null}

          {!loading && visibleCount === 0 ? (
            <div className="border-b border-rule-dark py-14">
              <h2 className="text-xl font-black">当前筛选还没有报道</h2>
              <p className="mt-2 text-sm leading-7 text-muted">可以切换媒体或主题，也可以继续加载更早的时间线。</p>
            </div>
          ) : null}

          <div aria-live="polite">
            {visibleDays.map((day, dayIndex) => (
              <section key={day.date} aria-labelledby={`day-${day.date}`} className="relative">
                <div className="sticky top-16 z-10 flex items-center gap-3 border-b border-rule-dark bg-[var(--app-canvas)] py-3">
                  <span className="h-2.5 w-2.5 bg-red" aria-hidden="true" />
                  <h2 id={`day-${day.date}`} className="font-sans text-xs font-black tracking-[0.12em]">{formatDay(day.date)}</h2>
                  {dayIndex === 0 ? <span className="font-sans text-[9px] font-black uppercase tracking-[0.16em] text-red">最新</span> : null}
                </div>

                <ol className="relative before:absolute before:bottom-0 before:left-[35px] before:top-0 before:w-px before:bg-red/45 md:before:left-[67px]">
                  {day.articles.map((article) => {
                    const category = primaryCategory(article);
                    return (
                      <li key={article.id} className="relative grid grid-cols-[52px_minmax(0,1fr)] gap-5 border-b border-rule py-5 md:grid-cols-[84px_minmax(0,1fr)] md:gap-6 md:py-7">
                        <time className="relative z-[1] mt-0.5 bg-[var(--app-canvas)] pr-2 text-right font-sans text-[11px] font-black tabular-nums text-red" dateTime={article.publishedAt}>
                          {formatClock(article.publishedAt)}
                        </time>
                        <article>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-[10px] font-bold tracking-[0.08em] text-muted">
                            <span className="text-red">{article.source.name}</span>
                            {category ? <span>{categoryLabel(category)}</span> : null}
                            {article.authors[0] ? <span>{article.authors[0]}</span> : null}
                          </div>
                          <Link
                            to={`/times/${encodeURIComponent(article.source.id)}/${article.issueDate}/${encodeURIComponent(article.id)}`}
                            className="group mt-2 block text-ink"
                          >
                            <h3 className="text-xl font-black leading-[1.45] transition-colors group-hover:text-red md:text-2xl">{article.title}</h3>
                            {article.summary ? <p className="mt-2 line-clamp-3 text-sm leading-7 text-muted md:text-[15px]">{article.summary}</p> : null}
                            <span className="mt-3 inline-block font-sans text-[10px] font-black tracking-[0.12em] text-red opacity-0 transition-opacity group-hover:opacity-100">阅读全文 →</span>
                          </Link>
                        </article>
                      </li>
                    );
                  })}
                </ol>
              </section>
            ))}
          </div>

          <div ref={sentinelRef} className="py-8 text-center">
            {loadMoreError ? <p className="mb-4 text-sm text-red">{loadMoreError}</p> : null}
            {hasMore ? (
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="border-y border-rule-dark px-8 py-3 font-sans text-xs font-black tracking-[0.12em] text-red transition-all hover:-translate-y-0.5 hover:shadow-[4px_4px_0_rgba(139,26,26,.14)] disabled:cursor-wait disabled:opacity-50"
              >
                {loadingMore ? "正在加载…" : "继续向前"}
              </button>
            ) : directory ? <p className="font-sans text-[10px] tracking-[0.12em] text-muted">已到达现有时间线起点</p> : null}
          </div>
        </div>
      </div>
    </main>
  );
}
