import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { timesApi, type TimesNewsItem } from "../api";

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void timesApi.listNews()
      .then((nextNews) => {
        if (!active) return;
        setNews(nextNews);
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
    <main className="min-h-[calc(100vh-64px)] bg-[var(--app-canvas)] px-5 py-6 text-ink md:px-8 md:py-8">
      <section className="mx-auto max-w-5xl">
        <div className="border-b-4 border-red pb-5">
          <h1 className="mt-4 text-4xl font-black tracking-[0.08em] md:text-5xl">今日时事</h1>
        </div>

        {loading ? <p className="mt-8 text-sm text-muted">正在读取新闻…</p> : null}
        {error ? <div role="alert" className="mt-8 border border-red p-5 text-sm text-red">{error}</div> : null}
        {!loading && !error && news.length === 0 ? (
          <div className="mt-8 border-2 border-rule-dark p-6">
            <h2 className="text-xl font-bold">还没有新闻数据</h2>
            <p className="mt-2 text-sm leading-7 text-muted">暂时没有可阅读的新闻。</p>
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
    </main>
  );
}
