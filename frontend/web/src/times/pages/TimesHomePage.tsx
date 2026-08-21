import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { timesApi, type TimesDigest, type TimesNewsItem, type TimesStats } from "../api";

const emptyDigest: TimesDigest = {
  articleCount: 0,
  hotKeywords: [],
  attentionLanes: [],
  starterQuestions: [],
  sourceCounts: [],
};

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

export function TimesHomePage() {
  const [news, setNews] = useState<TimesNewsItem[]>([]);
  const [digest, setDigest] = useState<TimesDigest>(emptyDigest);
  const [stats, setStats] = useState<TimesStats>({ total: 0, sourceCount: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([timesApi.listNews(), timesApi.getDigest(), timesApi.getStats()])
      .then(([nextNews, nextDigest, nextStats]) => {
        if (!active) return;
        setNews(nextNews);
        setDigest(nextDigest);
        setStats(nextStats);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "时事服务暂时不可用");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  return (
    <main className="mx-auto grid min-h-[calc(100vh-64px)] max-w-7xl gap-8 bg-paper px-5 py-6 text-ink md:grid-cols-[minmax(0,1fr)_360px] md:px-8 md:py-8">
        <section>
          <div className="border-b-4 border-red pb-5">
            <h1 className="mt-4 text-4xl font-black tracking-[0.08em] md:text-5xl">今日时事</h1>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-muted">
              先看事实，再查背景。当前汇总 {stats.sourceCount} 个来源、{stats.total} 条新闻。
            </p>
          </div>

          {loading ? <p className="mt-8 text-sm text-muted">正在读取新闻…</p> : null}
          {error ? <div role="alert" className="mt-8 border border-red p-5 text-sm text-red">{error}</div> : null}
          {!loading && !error && news.length === 0 ? (
            <div className="mt-8 border-2 border-rule-dark p-6">
              <h2 className="text-xl font-bold">还没有新闻数据</h2>
              <p className="mt-2 text-sm leading-7 text-muted">请等待服务端完成 RSS 来源配置和拉取。</p>
            </div>
          ) : null}

          <div className="mt-6 grid gap-3">
            {news.map((item, index) => (
              <article key={item.id} className="group border border-rule bg-paper p-4 transition-all hover:-translate-y-0.5 hover:border-red hover:shadow-[4px_4px_0_rgba(139,26,26,.14)]">
                <Link to={`/times/${item.id}`} className="grid gap-3 text-ink md:grid-cols-[52px_1fr]">
                  <div className="font-sans text-xs font-bold text-muted">#{String(index + 1).padStart(3, "0")}</div>
                  <div>
                    <div className="flex flex-wrap gap-3 text-xs text-muted">
                      <span>{item.source?.name || "未知来源"}</span>
                      <span>{formatDate(item.publishedAt)}</span>
                    </div>
                    <h2 className="mt-2 text-lg font-bold leading-snug group-hover:text-red">{item.title}</h2>
                    {item.summary ? <p className="mt-2 text-sm leading-6 text-muted">{item.summary}</p> : null}
                  </div>
                </Link>
              </article>
            ))}
          </div>
        </section>

        <aside className="space-y-5 md:sticky md:top-6 md:self-start">
          <section className="border-2 border-red p-5">
            <h2 className="text-2xl font-black">今日读法</h2>
            <div className="mt-4 space-y-3">
              {digest.starterQuestions.map((question) => <p key={question} className="border-l-4 border-red pl-3 text-sm leading-6">{question}</p>)}
              {!digest.starterQuestions.length ? <p className="text-sm text-muted">等待新闻数据生成读法。</p> : null}
            </div>
          </section>
          <section className="border border-rule p-5">
            <h2 className="text-lg font-bold">热词</h2>
            <div className="mt-4 flex flex-wrap gap-2">
              {digest.hotKeywords.slice(0, 12).map((term) => <span key={term.name} className="tag">{term.name} / {term.weight}</span>)}
            </div>
          </section>
          <section className="border border-rule p-5">
            <h2 className="text-lg font-bold">来源分布</h2>
            <div className="mt-4 space-y-2">
              {digest.sourceCounts.slice(0, 8).map((source) => (
                <div key={source.name} className="flex justify-between gap-3 text-sm"><span className="truncate text-muted">{source.name}</span><strong>{source.count}</strong></div>
              ))}
            </div>
          </section>
        </aside>
    </main>
  );
}
