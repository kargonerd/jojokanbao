import Link from "next/link";
import { fetchFromApi } from "../../api";
import AskAgentClient from "./AskAgentClient";
import HighlightClient from "./HighlightClient";

export const dynamic = "force-dynamic";

type ScrapbookItem = {
  id: string;
  reason: string;
  score: number;
  relatedNews: { id: string; title: string; publishedAt?: string; url?: string | null };
};

type Highlight = {
  id: string;
  text: string;
  startOffset: number;
  endOffset: number;
  createdAt: string;
  displayName?: string | null;
};

type Comment = {
  id: string;
  content: string;
  highlightId: string;
  highlight?: { id: string };
  createdAt: string;
  displayName?: string | null;
};

type NewsDetail = {
  news: {
    id: string;
    title: string;
    summary?: string | null;
    content: string;
    url?: string | null;
    publishedAt: string;
    source?: { name: string } | null;
  };
  scrapbookItems: ScrapbookItem[];
  highlights: Highlight[];
  comments: Comment[];
};

type Briefing = {
  agent: { name: string; loop: { step: string; description: string }[] };
  tldr: string;
  keyPoints: string[];
  entities: { name: string; type: string; confidence: number }[];
  timeline: { date: string; label: string; detail: string }[];
  readingQuestions: string[];
  stanceChecks: string[];
  readingActions: { label: string; prompt: string }[];
  oldContext: { id: string; title: string; reason: string; score: number; url?: string | null; source?: { name: string } | null }[];
};

function formatDate(value: string) {
  try {
    return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  } catch {
    return value;
  }
}

export default async function NewsDetailPage({ params }: { params: { id: string } }) {
  const data = await fetchFromApi<NewsDetail | null>(`/news/${params.id}`, null);
  if (!data) {
    return (
      <div className="min-h-screen bg-paper p-6 text-ink">
        <Link href="/" className="font-bold text-red">
          返回首页
        </Link>
        <div className="mt-8 border-2 border-rule-dark p-6 font-bold text-muted">未找到新闻</div>
      </div>
    );
  }

  const briefing = await fetchFromApi<Briefing | null>(`/ai/briefing/${params.id}`, null);

  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="border-b-2 border-rule-dark px-5 py-4 md:px-8">
        <div className="mx-auto flex max-w-6xl items-center gap-4">
          <Link href="/" className="font-bold tracking-[0.16em] text-red">
            JOJO旧闻
          </Link>
          <span className="text-xs font-bold tracking-[0.18em] text-muted">阅读现场</span>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-8 px-5 py-8 md:grid-cols-[minmax(0,1fr)_340px] md:px-8">
        <article>
          <div className="border-b-4 border-red pb-6">
            <div className="flex flex-wrap items-center gap-3 text-xs font-bold tracking-[0.12em] text-muted">
              <span>{data.news.source?.name || "未知来源"}</span>
              <span>{formatDate(data.news.publishedAt)}</span>
              {data.news.url ? (
                <a href={data.news.url} target="_blank" rel="noreferrer" className="text-red">
                  原文
                </a>
              ) : null}
            </div>
            <h1 className="m-0 mt-4 text-4xl font-black leading-tight tracking-[0.04em] md:text-5xl">{data.news.title}</h1>
            {data.news.summary ? <p className="mt-5 text-base leading-8 text-muted">{data.news.summary}</p> : null}
          </div>

          {briefing ? (
            <section className="mt-8 border-2 border-red p-5">
              <p className="m-0 text-xs font-bold tracking-[0.2em] text-red">PI AGENT BRIEFING</p>
              <p className="mt-3 text-lg font-bold leading-8">{briefing.tldr}</p>
              <div className="mt-5 grid gap-5 md:grid-cols-2">
                <div>
                  <h2 className="m-0 text-sm font-bold tracking-[0.12em] text-muted">关键点</h2>
                  <ul className="mt-3 space-y-2 pl-5 text-sm leading-6">
                    {briefing.keyPoints.map((point) => (
                      <li key={point}>{point}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h2 className="m-0 text-sm font-bold tracking-[0.12em] text-muted">证据检查</h2>
                  <ul className="mt-3 space-y-2 pl-5 text-sm leading-6">
                    {briefing.stanceChecks.map((check) => (
                      <li key={check}>{check}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </section>
          ) : null}

          <section className="mt-8">
            <h2 className="m-0 border-b border-rule-dark pb-3 text-xl font-black">正文</h2>
            <div className="mt-5 whitespace-pre-line text-base leading-9 text-ink/85">{data.news.content}</div>
          </section>

          <section className="mt-10">
            <h2 className="m-0 border-b border-rule-dark pb-3 text-xl font-black">旧闻对照</h2>
            <div className="mt-4 space-y-3">
              {data.scrapbookItems.length === 0 && briefing?.oldContext.length === 0 ? (
                <div className="border border-rule p-4 text-sm text-muted">暂无旧闻候选。运行验证脚本后会批量生成合订本关联。</div>
              ) : null}
              {data.scrapbookItems.map((item) => (
                <a
                  key={item.id}
                  href={item.relatedNews.url || `/news/${item.relatedNews.id}`}
                  className="block border border-rule p-4 text-ink hover:border-red hover:text-red"
                >
                  <div className="text-xs font-bold tracking-[0.14em] text-muted">反差评分 {item.score.toFixed(2)}</div>
                  <div className="mt-2 font-bold">{item.relatedNews.title}</div>
                  <div className="mt-2 text-sm leading-6 text-muted">{item.reason}</div>
                </a>
              ))}
              {data.scrapbookItems.length === 0
                ? briefing?.oldContext.map((item) => (
                    <a
                      key={item.id}
                      href={item.url || `/news/${item.id}`}
                      className="block border border-rule p-4 text-ink hover:border-red hover:text-red"
                    >
                      <div className="text-xs font-bold tracking-[0.14em] text-muted">候选关联 {item.score.toFixed(2)}</div>
                      <div className="mt-2 font-bold">{item.title}</div>
                      <div className="mt-2 text-sm leading-6 text-muted">{item.reason}</div>
                    </a>
                  ))
                : null}
            </div>
          </section>

          <AskAgentClient newsId={data.news.id} />

          <HighlightClient newsId={data.news.id} content={data.news.content} highlights={data.highlights} comments={data.comments} />
        </article>

        <aside className="space-y-5 md:sticky md:top-6 md:self-start">
          {briefing ? (
            <>
              <section className="border border-rule p-5">
                <h2 className="m-0 text-lg font-black">Pi 阅读循环</h2>
                <div className="mt-4 space-y-3">
                  {briefing.agent.loop.map((step) => (
                    <div key={step.step} className="border-l-4 border-red pl-3">
                      <div className="font-sans text-xs font-bold tracking-[0.16em] text-red">{step.step}</div>
                      <p className="m-0 mt-1 text-sm leading-6 text-muted">{step.description}</p>
                    </div>
                  ))}
                </div>
              </section>

              <section className="border border-rule p-5">
                <h2 className="m-0 text-lg font-black">追问</h2>
                <div className="mt-4 space-y-3">
                  {briefing.readingQuestions.map((question) => (
                    <p key={question} className="m-0 text-sm leading-6 text-ink">
                      {question}
                    </p>
                  ))}
                </div>
              </section>

              <section className="border border-rule p-5">
                <h2 className="m-0 text-lg font-black">实体</h2>
                <div className="mt-4 flex flex-wrap gap-2">
                  {briefing.entities.slice(0, 12).map((entity) => (
                    <span key={`${entity.name}-${entity.type}`} className="tag">
                      {entity.name} · {entity.type}
                    </span>
                  ))}
                </div>
              </section>

              <section className="border border-rule p-5">
                <h2 className="m-0 text-lg font-black">时间线</h2>
                <div className="mt-4 space-y-3">
                  {briefing.timeline.map((item) => (
                    <div key={`${item.date}-${item.detail}`} className="border-t border-rule pt-3">
                      <div className="font-sans text-xs font-bold text-red">{item.date}</div>
                      <p className="m-0 mt-1 text-sm leading-6 text-muted">{item.detail}</p>
                    </div>
                  ))}
                </div>
              </section>
            </>
          ) : null}
        </aside>
      </main>
    </div>
  );
}
