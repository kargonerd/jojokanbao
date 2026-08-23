import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { TimesSourceHealthStatus } from "@jojo/content";
import { timesApi, type TimesOverview } from "../api";

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

const healthLabels: Record<TimesSourceHealthStatus, string> = {
  healthy: "健康",
  degraded: "降级",
  unavailable: "不可用",
};

const healthClasses: Record<TimesSourceHealthStatus, string> = {
  healthy: "border-ink bg-ink text-paper",
  degraded: "border-[#9a6500] bg-[#fff3cc] text-[#6c4700]",
  unavailable: "border-red bg-red text-paper",
};

export function TimesHomePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedSource = searchParams.get("source") || "all";
  const [overview, setOverview] = useState<TimesOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [caseLimit, setCaseLimit] = useState(20);
  const [articleLimit, setArticleLimit] = useState(50);

  useEffect(() => {
    let active = true;
    void timesApi.overview()
      .then((nextOverview) => {
        if (active) setOverview(nextOverview);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "时事数据暂时不可用");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  const news = useMemo(() => overview?.articles.filter(
    (item) => selectedSource === "all" || item.source.id === selectedSource,
  ) ?? [], [overview, selectedSource]);
  const cases = useMemo(() => overview?.unavailableCases.filter(
    (item) => selectedSource === "all" || item.source.id === selectedSource,
  ) ?? [], [overview, selectedSource]);
  const selectedHealth = overview?.sourceHealth.find((item) => item.source.id === selectedSource);
  const totalDiscovered = overview?.sourceHealth.reduce((sum, item) => sum + item.discovered, 0) ?? 0;
  const totalDelivered = overview?.sourceHealth.reduce((sum, item) => sum + item.delivered, 0) ?? 0;

  function chooseSource(sourceId: string) {
    setCaseLimit(20);
    setArticleLimit(50);
    const next = new URLSearchParams(searchParams);
    if (sourceId === "all") next.delete("source");
    else next.set("source", sourceId);
    setSearchParams(next, { replace: true });
  }

  return (
    <main className="min-h-[calc(100vh-64px)] bg-[var(--app-canvas)] px-4 py-5 text-ink md:px-8 md:py-8">
      <div className="mx-auto max-w-7xl">
        <header className="grid border-y-4 border-red bg-paper lg:grid-cols-[1fr_320px]">
          <div className="px-5 py-7 md:px-8 md:py-9">
            <p className="font-sans text-[11px] font-black uppercase tracking-[0.28em] text-red">Wire audit / rolling 24 hours</p>
            <h1 className="mt-3 max-w-4xl text-4xl font-black leading-[1.08] tracking-[0.04em] md:text-6xl">过去一天，逐家核验</h1>
            <p className="mt-4 max-w-3xl text-sm leading-7 text-muted">
              这里同时展示可读新闻和抓取失败。选择任一媒体，可以单独检查它的全文率、不可用链接和实际文章。
            </p>
          </div>
          <div className="border-t-2 border-red bg-red px-5 py-6 text-paper lg:border-l-2 lg:border-t-0">
            <p className="font-sans text-[10px] font-bold uppercase tracking-[0.22em] opacity-75">Audit window</p>
            <p className="mt-3 font-sans text-sm font-bold leading-7">
              {overview ? `${formatDate(overview.window.from)} — ${formatDate(overview.window.to)}` : "正在读取时间窗口…"}
            </p>
            <p className="mt-5 border-t border-white/40 pt-4 font-sans text-xs leading-6 opacity-80">
              数据更新：{overview ? formatDate(overview.updatedAt) : "—"}
            </p>
          </div>
        </header>

        {loading ? <p className="mt-8 text-sm text-muted">正在读取新闻与健康数据…</p> : null}
        {error ? <div role="alert" className="mt-8 border-2 border-red bg-paper p-5 text-sm text-red">{error}</div> : null}

        {overview ? (
          <>
            <section aria-label="抓取总览" className="grid border-b-2 border-rule-dark bg-paper sm:grid-cols-2 lg:grid-cols-4">
              {[
                ["接入媒体", String(overview.sourceHealth.length)],
                ["发现链接", String(totalDiscovered)],
                ["可阅读", String(totalDelivered)],
                ["不可用 case", String(overview.unavailableCases.length)],
              ].map(([label, value], index) => (
                <div key={label} className={`px-5 py-5 ${index ? "border-t border-rule sm:border-l sm:border-t-0" : ""}`}>
                  <p className="font-sans text-[10px] font-bold uppercase tracking-[0.18em] text-muted">{label}</p>
                  <p className="mt-1 font-sans text-3xl font-black tabular-nums">{value}</p>
                </div>
              ))}
            </section>

            <section className="mt-8">
              <div className="flex flex-col gap-4 border-b-2 border-ink pb-3 md:flex-row md:items-end md:justify-between">
                <div>
                  <p className="font-sans text-[10px] font-bold uppercase tracking-[0.2em] text-red">Source ledger</p>
                  <h2 className="mt-1 text-2xl font-black">媒体健康度</h2>
                </div>
                <label className="font-sans text-xs font-bold">
                  查看媒体
                  <select
                    aria-label="查看媒体"
                    value={selectedSource}
                    onChange={(event) => chooseSource(event.target.value)}
                    className="ml-3 min-w-56 border-2 border-ink bg-paper px-3 py-2 text-sm font-bold outline-none focus:border-red"
                  >
                    <option value="all">所有媒体</option>
                    {overview.sourceHealth.map((item) => <option key={item.source.id} value={item.source.id}>{item.source.name}</option>)}
                  </select>
                </label>
              </div>

              <div className="grid bg-paper lg:grid-cols-2">
                {overview.sourceHealth.map((item) => {
                  const active = selectedSource === item.source.id;
                  return (
                    <button
                      type="button"
                      key={item.source.id}
                      aria-pressed={active}
                      onClick={() => chooseSource(active ? "all" : item.source.id)}
                      className={`grid w-full grid-cols-[1fr_auto] gap-4 border-b border-rule px-4 py-4 text-left transition-colors hover:bg-[#fff7f5] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red md:px-5 ${active ? "bg-[#fff0ed] shadow-[inset_5px_0_0_#8b1a1a]" : ""}`}
                    >
                      <span>
                        <span className="flex flex-wrap items-center gap-2">
                          <strong className="text-base">{item.source.name}</strong>
                          <span className={`border px-2 py-0.5 font-sans text-[10px] font-black ${healthClasses[item.status]}`}>{healthLabels[item.status]}</span>
                        </span>
                        <span className="mt-2 block font-sans text-xs text-muted">
                          发现 {item.discovered} · 全文 {item.full} · 摘要 {item.summary} · 不可用 {item.unavailable}
                          {item.browserAttempts ? ` · 原页归档 ${item.browserSucceeded}/${item.browserAttempts}` : ""}
                        </span>
                        <span className="mt-3 block h-1.5 bg-rule">
                          <span className="block h-full bg-red" style={{ width: `${item.healthScore}%` }} />
                        </span>
                      </span>
                      <span className="text-right font-sans">
                        <strong className="block text-2xl tabular-nums">{item.healthScore}</strong>
                        <span className="block text-[10px] text-muted">健康分</span>
                        <span className="mt-2 block text-[10px] text-muted">可用 {percent(item.availabilityRate)} / 全文 {percent(item.fullTextRate)}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="mt-10 border-t-4 border-red bg-paper">
              <div className="flex flex-wrap items-end justify-between gap-3 border-b border-rule px-5 py-4">
                <div>
                  <p className="font-sans text-[10px] font-bold uppercase tracking-[0.2em] text-red">Failure desk</p>
                  <h2 className="mt-1 text-2xl font-black">不可用 case</h2>
                </div>
                <p className="font-sans text-xs text-muted">{selectedHealth ? selectedHealth.source.name : "全部媒体"} · {cases.length} 条</p>
              </div>
              {cases.length ? (
                <div>
                  {cases.slice(0, caseLimit).map((item) => (
                    <article key={item.id} className="grid gap-2 border-b border-rule px-5 py-4 md:grid-cols-[150px_1fr_auto] md:items-start">
                      <div className="font-sans text-xs">
                        <strong className="block text-red">{item.source.name}</strong>
                        <span className="mt-1 block text-muted">{item.stage} / {item.reason}</span>
                      </div>
                      <div>
                        <h3 className="text-sm font-bold leading-6">{item.title || "来源级错误"}</h3>
                        <p className="mt-1 font-sans text-xs leading-5 text-muted">{item.message}</p>
                      </div>
                      <div className="font-sans text-xs text-muted md:text-right">
                        {item.publishedAt ? <span className="block">{formatDate(item.publishedAt)}</span> : null}
                        {item.url ? <a href={item.url} target="_blank" rel="noreferrer" className="mt-1 inline-block font-bold text-red">检查原页 ↗</a> : null}
                      </div>
                    </article>
                  ))}
                  {caseLimit < cases.length ? (
                    <button type="button" onClick={() => setCaseLimit((value) => value + 50)} className="w-full border-0 bg-transparent px-5 py-4 font-sans text-xs font-black text-red hover:bg-[#fff7f5]">再显示 50 条</button>
                  ) : null}
                </div>
              ) : <p className="px-5 py-6 text-sm text-muted">当前筛选下没有不可用 case。</p>}
            </section>

            <section className="mt-10">
              <div className="flex items-end justify-between gap-4 border-b-4 border-ink pb-3">
                <div>
                  <p className="font-sans text-[10px] font-bold uppercase tracking-[0.2em] text-red">Readable wire</p>
                  <h2 className="mt-1 text-2xl font-black">可阅读新闻</h2>
                </div>
                <p className="font-sans text-xs text-muted">{news.length} 篇</p>
              </div>
              {news.length ? (
                <div className="grid bg-paper lg:grid-cols-2">
                  {news.slice(0, articleLimit).map((item, index) => (
                    <article key={item.id} className="group border-b border-rule p-5 transition-all hover:bg-[#fff7f5] lg:odd:border-r">
                      <Link to={`/times/${encodeURIComponent(item.id)}`} className="grid grid-cols-[42px_1fr] gap-3 text-ink">
                        <span className="font-sans text-[10px] font-black text-muted">{String(index + 1).padStart(3, "0")}</span>
                        <span>
                          <span className="flex flex-wrap gap-3 font-sans text-[10px] font-bold uppercase tracking-[0.08em] text-muted">
                            <span className="text-red">{item.source.name}</span>
                            <span>{formatDate(item.publishedAt)}</span>
                            <span>{item.contentStatus === "full" ? "全文" : item.contentStatus === "partial" ? "部分" : "摘要"}</span>
                          </span>
                          <strong className="mt-2 block text-lg leading-snug group-hover:text-red">{item.title}</strong>
                          {item.summary ? <span className="mt-2 line-clamp-3 block text-sm leading-6 text-muted">{item.summary.slice(0, 240)}</span> : null}
                        </span>
                      </Link>
                    </article>
                  ))}
                  {articleLimit < news.length ? (
                    <button type="button" onClick={() => setArticleLimit((value) => value + 50)} className="border-b border-rule bg-transparent px-5 py-5 font-sans text-xs font-black text-red hover:bg-[#fff7f5] lg:col-span-2">再显示 50 篇</button>
                  ) : null}
                </div>
              ) : (
                <div className="border-2 border-rule-dark bg-paper p-6">
                  <h3 className="text-lg font-bold">这个媒体暂时没有可阅读文章</h3>
                  <p className="mt-2 text-sm leading-7 text-muted">上面的不可用 case 会说明发现、抓取或 Canonical 阶段出了什么问题。</p>
                </div>
              )}
            </section>
          </>
        ) : null}
      </div>
    </main>
  );
}
