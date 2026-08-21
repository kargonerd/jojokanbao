import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { SelectableAnnotationArticle } from "../../annotations/SelectableAnnotationArticle";
import { timesApi, type TimesBriefing, type TimesNewsDetail } from "../api";

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
  const [detail, setDetail] = useState<TimesNewsDetail | null>(null);
  const [briefing, setBriefing] = useState<TimesBriefing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const originalUrl = safeNewsUrl(detail?.news.url);

  useEffect(() => {
    let active = true;
    setError(null);
    void Promise.all([timesApi.getNews(newsId), timesApi.getBriefing(newsId).catch(() => null)])
      .then(([nextDetail, nextBriefing]) => {
        if (!active) return;
        setDetail(nextDetail);
        setBriefing(nextBriefing);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "新闻读取失败");
      });
    return () => { active = false; };
  }, [newsId]);

  return (
    <main className="mx-auto min-h-[calc(100vh-64px)] max-w-5xl bg-paper px-5 py-8 text-ink md:px-8">
        <Link to="/times" className="text-sm font-bold">← 返回今日时事</Link>
        {error ? <div role="alert" className="mt-6 border border-red p-5 text-sm text-red">{error}</div> : null}
        {!detail && !error ? <p className="mt-8 text-sm text-muted">正在读取新闻…</p> : null}
        {detail ? (
          <article className="mt-6 grid gap-8 md:grid-cols-[minmax(0,1fr)_280px]">
            <div>
              <p className="kicker">{detail.news.source?.name || "未知来源"} · {detail.news.publishedAt}</p>
              <h1 className="mt-4 text-3xl font-black leading-tight md:text-5xl">{detail.news.title}</h1>
              {detail.news.summary ? <p className="mt-5 border-l-4 border-red pl-4 text-base leading-8 text-muted">{detail.news.summary}</p> : null}
              <SelectableAnnotationArticle subject={{
                contentType: "newspaper",
                contentId: detail.news.id,
                sectionId: "body",
                contentTitle: detail.news.title,
                contentUrl: window.location.pathname,
              }}>
                <div className="mt-8 whitespace-pre-wrap text-base leading-8">{detail.news.content || "暂无正文。"}</div>
              </SelectableAnnotationArticle>
              {originalUrl ? <a className="mt-6 inline-block text-sm font-bold" href={originalUrl} target="_blank" rel="noreferrer">查看原文 ↗</a> : null}

            </div>

            <aside className="space-y-5">
              <section className="border border-rule p-5">
                <h2 className="text-lg font-black">历史对照</h2>
                <div className="mt-4 space-y-4">
                  {(detail.scrapbookItems || []).map((item) => (
                    <Link key={item.id} to={`/times/${item.relatedNews.id}`} className="block border-t border-rule pt-3 text-ink hover:text-red">
                      <strong>{item.relatedNews.title}</strong>
                      <p className="mt-1 text-xs leading-5 text-muted">{item.reason}</p>
                    </Link>
                  ))}
                  {!detail.scrapbookItems?.length ? <p className="text-sm text-muted">暂未生成历史关联。</p> : null}
                </div>
              </section>
              {briefing?.readingQuestions?.length ? (
                <section className="border border-rule p-5">
                  <h2 className="text-lg font-black">继续追问</h2>
                  {briefing.readingQuestions.map((item) => <p key={item} className="mt-3 text-sm leading-6">{item}</p>)}
                </section>
              ) : null}
            </aside>
          </article>
        ) : null}
    </main>
  );
}
