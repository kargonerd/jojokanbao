import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { TimesTimelineIndex } from "@jojo/content";
import { timesApi, type TimesNewsItem } from "../api";

function articleTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "—" : new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function dayLabel(value: string): { date: string; weekday: string } {
  const date = new Date(`${value}T00:00:00Z`);
  return {
    date: new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", timeZone: "UTC" }).format(date),
    weekday: new Intl.DateTimeFormat("zh-CN", { weekday: "long", timeZone: "UTC" }).format(date),
  };
}

export function TimesHomePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedSource = searchParams.get("source") || "all";
  const [index, setIndex] = useState<TimesTimelineIndex | null>(null);
  const [days, setDays] = useState<Array<{ date: string; articles: TimesNewsItem[] }>>([]);
  const [nextDay, setNextDay] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sentinel = useRef<HTMLDivElement | null>(null);

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
    }, { rootMargin: "500px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [index, loadMore]);

  const visibleDays = useMemo(() => days.map((day) => ({
    ...day,
    articles: day.articles.filter((article) => selectedSource === "all" || article.source.id === selectedSource),
  })).filter((day) => day.articles.length), [days, selectedSource]);

  function chooseSource(sourceId: string) {
    const next = new URLSearchParams(searchParams);
    if (sourceId === "all") next.delete("source");
    else next.set("source", sourceId);
    setSearchParams(next, { replace: true });
  }

  return (
    <main className="min-h-[calc(100vh-64px)] bg-[var(--app-canvas)] text-ink">
      <header className="sticky top-0 z-20 border-b-2 border-ink bg-paper/95 backdrop-blur-sm">
        <div className="mx-auto max-w-[1480px] px-4 py-4 md:px-8">
          <div className="flex items-end justify-between gap-5">
            <div className="flex items-baseline gap-4">
              <h1 className="text-3xl font-black tracking-[0.08em] md:text-4xl">时事</h1>
              <p className="hidden font-sans text-[10px] font-bold uppercase tracking-[0.22em] text-red sm:block">Global wire · ten-minute edition</p>
            </div>
            <p className="font-sans text-[10px] text-muted">
              {index ? `更新于 ${new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(index.updatedAt))}` : "读取中"}
            </p>
          </div>
          <div className="-mx-4 mt-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] md:-mx-8 md:px-8">
            <button type="button" onClick={() => chooseSource("all")} className={`shrink-0 border px-3 py-1.5 font-sans text-xs font-bold transition-colors ${selectedSource === "all" ? "border-red bg-red text-paper" : "border-rule-dark bg-paper hover:border-red hover:text-red"}`}>全部</button>
            {index?.sources.map((source) => (
              <button key={source.id} type="button" onClick={() => chooseSource(source.id)} className={`shrink-0 border px-3 py-1.5 font-sans text-xs font-bold transition-colors ${selectedSource === source.id ? "border-red bg-red text-paper" : "border-rule-dark bg-paper hover:border-red hover:text-red"}`}>
                {source.name}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1480px] px-4 pb-20 md:px-8">
        {loading ? <p className="border-b border-rule py-10 font-sans text-sm text-muted">正在编排最新时间线…</p> : null}
        {error ? <div role="alert" className="my-6 border-2 border-red bg-paper p-5 font-sans text-sm text-red">{error}</div> : null}

        {visibleDays.map((day) => {
          const label = dayLabel(day.date);
          return (
            <section key={day.date} className="grid border-b-2 border-ink md:grid-cols-[150px_minmax(0,1fr)] lg:grid-cols-[190px_minmax(0,1fr)]">
              <div className="border-b border-rule bg-[var(--app-canvas)] py-5 md:border-b-0 md:border-r md:py-7">
                <div className="md:sticky md:top-[138px]">
                  <p className="text-2xl font-black md:text-3xl">{label.date}</p>
                  <p className="mt-1 font-sans text-[10px] font-bold uppercase tracking-[0.18em] text-red">{label.weekday} · {day.articles.length} 篇</p>
                </div>
              </div>
              <div className="bg-paper">
                {day.articles.map((article) => (
                  <article key={article.id} className="group grid grid-cols-[52px_minmax(0,1fr)] border-b border-rule px-3 py-5 last:border-b-0 sm:grid-cols-[72px_minmax(0,1fr)] sm:px-5 lg:grid-cols-[84px_minmax(0,1fr)_180px] lg:gap-5 lg:px-7 lg:py-6">
                    <time className="pt-0.5 font-sans text-[11px] font-bold tabular-nums text-muted">{articleTime(article.publishedAt)}</time>
                    <Link to={`/times/${article.issueDate}/${encodeURIComponent(article.id)}`} className="min-w-0 text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-red">
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-[10px] font-black uppercase tracking-[0.08em] text-red">
                        <span>{article.source.name}</span>
                        {article.publisherSections?.slice(0, 2).map((section) => <span key={section.id} className="font-medium normal-case tracking-normal text-muted">{section.name}</span>)}
                      </span>
                      <strong className="mt-1.5 block text-lg leading-snug transition-colors group-hover:text-red sm:text-xl">{article.title}</strong>
                      {article.summary ? <span className="mt-2 line-clamp-2 block text-sm leading-6 text-muted">{article.summary}</span> : null}
                    </Link>
                    <div className="hidden items-start justify-end lg:flex">
                      {article.assets.find((asset) => asset.role === "lead") ? (
                        <span className="border-l-2 border-red pl-3 font-sans text-[10px] font-bold uppercase tracking-[0.15em] text-muted">图文存档</span>
                      ) : <span className="font-sans text-[10px] text-muted">全文</span>}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          );
        })}

        {!loading && !visibleDays.length && !error ? (
          <div className="border-b-2 border-ink bg-paper py-16 text-center">
            <p className="text-xl font-black">这个媒体在已加载日期里没有文章</p>
            <button type="button" onClick={() => chooseSource("all")} className="mt-4 border-b border-red font-sans text-sm font-bold text-red">查看全部媒体</button>
          </div>
        ) : null}
        <div ref={sentinel} className="flex h-24 items-center justify-center font-sans text-xs text-muted">
          {loadingMore ? "正在加载更早的日期…" : index && nextDay >= index.dates.length ? "已到达时间线起点" : ""}
        </div>
      </div>
    </main>
  );
}
