import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { SelectableAnnotationArticle } from "../../annotations/SelectableAnnotationArticle";
import { timesApi, type TimesNewsItem } from "../api";

function safeNewsUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function TimesDetailPage() {
  const { newsId = "" } = useParams();
  const [news, setNews] = useState<TimesNewsItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const originalUrl = safeNewsUrl(news?.url);

  useEffect(() => {
    let active = true;
    setError(null);
    void timesApi.getNews(newsId)
      .then((nextNews) => {
        if (active) setNews(nextNews);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "新闻读取失败");
      });
    return () => { active = false; };
  }, [newsId]);

  return (
    <main className="min-h-[calc(100vh-64px)] bg-[var(--app-canvas)] px-5 py-8 text-ink md:px-8">
      <div className="mx-auto max-w-4xl">
        <Link to="/times" className="text-sm font-bold">← 返回今日时事</Link>
        {error ? <div role="alert" className="mt-6 border border-red p-5 text-sm text-red">{error}</div> : null}
        {!news && !error ? <p className="mt-8 text-sm text-muted">正在读取新闻…</p> : null}
        {news ? (
          <article className="mt-6 bg-paper px-5 py-7 md:px-10 md:py-10">
            <p className="kicker">{news.source?.name || "未知来源"} · {news.publishedAt}</p>
            <h1 className="mt-4 text-3xl font-black leading-tight md:text-5xl">{news.title}</h1>
            {news.summary ? <p className="mt-5 border-l-4 border-red pl-4 text-base leading-8 text-muted">{news.summary}</p> : null}
            <SelectableAnnotationArticle subject={{
              contentType: "newspaper",
              contentId: news.id,
              sectionId: "body",
              contentTitle: news.title,
              contentUrl: window.location.pathname,
            }}>
              <div className="mt-8 whitespace-pre-wrap text-base leading-8">{news.content || "暂无正文。"}</div>
            </SelectableAnnotationArticle>
            {originalUrl ? <a className="mt-6 inline-block text-sm font-bold" href={originalUrl} target="_blank" rel="noreferrer">查看原文 ↗</a> : null}
          </article>
        ) : null}
      </div>
    </main>
  );
}
