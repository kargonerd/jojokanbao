import DOMPurify from "dompurify";
import { useEffect, useMemo, useState } from "react";
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
  const backUrl = news?.source?.id ? `/times?source=${encodeURIComponent(news.source.id)}` : "/times";
  const articleHtml = useMemo(() => {
    if (!news?.content || news.contentFormat !== "html") return null;
    return DOMPurify.sanitize(news.content);
  }, [news?.content, news?.contentFormat]);

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
        <Link to={backUrl} className="text-sm font-bold">← 返回时事审计</Link>
        {error ? <div role="alert" className="mt-6 border border-red p-5 text-sm text-red">{error}</div> : null}
        {!news && !error ? <p className="mt-8 text-sm text-muted">正在读取新闻…</p> : null}
        {news ? (
          <article className="mt-6 bg-paper px-5 py-7 md:px-10 md:py-10">
            <p className="kicker">
              {news.source?.name || "未知来源"} · {news.publishedAt} · {
                news.contentStatus === "full" ? "全文" : news.contentStatus === "summary" ? "摘要" : "部分正文"
              }
            </p>
            <h1 className="mt-4 text-3xl font-black leading-tight md:text-5xl">{news.title}</h1>
            {news.summary ? <p className="mt-5 border-l-4 border-red pl-4 text-base leading-8 text-muted">{news.summary}</p> : null}
            <SelectableAnnotationArticle subject={{
              contentType: "newspaper",
              contentId: news.id,
              sectionId: "body",
              contentTitle: news.title,
              contentUrl: window.location.pathname,
            }}>
              {articleHtml ? (
                <div
                  className="prose-editorial mt-8 text-base leading-8 [&_p]:my-[1.1em] [&_p]:text-justify [&_p]:indent-[2em] [&_figure]:my-8 [&_img]:mx-auto [&_img]:max-w-full"
                  dangerouslySetInnerHTML={{ __html: articleHtml }}
                />
              ) : (
                <div className="mt-8 whitespace-pre-wrap text-base leading-8">{news.content || "暂无正文。"}</div>
              )}
            </SelectableAnnotationArticle>
            {news.contentStatus === "summary" ? (
              <p className="mt-5 border-t border-rule pt-4 text-sm leading-6 text-muted">
                当前离线版本仅保存标题与摘要；完整内容请前往出版方原文。
              </p>
            ) : null}
            {news.contentStatus === "partial" ? (
              <p className="mt-5 border-t border-rule pt-4 text-sm leading-6 text-muted">
                当前离线解析得到的是部分正文；原始网页响应已存档，可在解析器升级后重新处理。
              </p>
            ) : null}
            {originalUrl ? <a className="mt-6 inline-block text-sm font-bold" href={originalUrl} target="_blank" rel="noreferrer">查看原文 ↗</a> : null}
          </article>
        ) : null}
      </div>
    </main>
  );
}
