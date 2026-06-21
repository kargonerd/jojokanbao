import Link from "next/link";
import { fetchFromApi } from "./api";

export const dynamic = "force-dynamic";

type NewsItem = {
  id: string;
  title: string;
  summary?: string | null;
  publishedAt: string;
  source?: { name: string } | null;
};

type Digest = {
  articleCount: number;
  hotKeywords: { name: string; weight: number }[];
  attentionLanes: { label: string; why: string; articleIds: string[]; titles: string[] }[];
  starterQuestions: string[];
  sourceCounts: { name: string; count: number }[];
};

type Stats = {
  total: number;
  sourceCount: number;
};

function formatDate(value: string) {
  try {
    return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(
      new Date(value)
    );
  } catch {
    return value;
  }
}

export default async function Home() {
  const [news, digest, stats] = await Promise.all([
    fetchFromApi<NewsItem[]>("/news?limit=100", []),
    fetchFromApi<Digest>("/ai/digest?limit=100", {
      articleCount: 0,
      hotKeywords: [],
      attentionLanes: [],
      starterQuestions: [],
      sourceCounts: [],
    }),
    fetchFromApi<Stats>("/stats", { total: 0, sourceCount: 0 }),
  ]);

  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="border-b-2 border-rule-dark px-5 py-4 md:px-8">
        <div className="mx-auto flex max-w-7xl items-center gap-5">
          <Link href="/" className="text-xl font-bold tracking-[0.18em] text-red">
            JOJO旧闻
          </Link>
          <div className="hidden h-5 w-px bg-rule-dark md:block" />
          <p className="m-0 hidden text-xs font-bold tracking-[0.18em] text-muted md:block">AI 辅助阅读新闻</p>
          <nav className="ml-auto flex items-center gap-4 text-sm">
            <Link href="/admin/sources" className="font-bold text-ink hover:text-red">
              来源管理
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-8 px-5 py-6 md:grid-cols-[minmax(0,1fr)_360px] md:px-8 md:py-8">
        <section>
          <div className="border-b-4 border-red pb-5">
            <p className="kicker m-0">Pi Agent Dispatch</p>
            <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
              <div>
                <h1 className="m-0 text-4xl font-black tracking-[0.08em] text-ink md:text-5xl">今日旧闻</h1>
                <p className="mt-3 max-w-2xl text-sm leading-7 text-muted">
                  先看事实，再查旧闻，最后追问。当前已接入 {stats.sourceCount} 个来源，数据库内 {stats.total} 条新闻。
                </p>
              </div>
              <div className="border-2 border-red px-4 py-3 text-right">
                <div className="text-3xl font-black text-red">{digest.articleCount}</div>
                <div className="text-xs font-bold tracking-[0.2em] text-muted">AGENT 读入</div>
              </div>
            </div>
          </div>

          {news.length === 0 ? (
            <div className="mt-8 border-2 border-rule-dark p-6">
              <h2 className="m-0 text-xl font-bold">还没有新闻数据</h2>
              <p className="mt-2 text-sm leading-7 text-muted">
                先运行后端抓取脚本，或在来源管理里添加 RSS 后拉取。抓取完成后这里会显示 100 条测试新闻和 AI 读法。
              </p>
            </div>
          ) : (
            <div className="mt-6 grid gap-3">
              {news.map((item, index) => (
                <article
                  key={item.id}
                  className="group border border-rule bg-paper p-4 transition-all duration-[180ms] hover:-translate-y-0.5 hover:border-red hover:shadow-[4px_4px_0_rgba(139,26,26,.14)]"
                >
                  <Link href={`/news/${item.id}`} className="grid gap-3 text-ink md:grid-cols-[52px_1fr]">
                    <div className="font-sans text-xs font-bold text-muted">#{String(index + 1).padStart(3, "0")}</div>
                    <div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                        <span>{item.source?.name || "未知来源"}</span>
                        <span>{formatDate(item.publishedAt)}</span>
                      </div>
                      <h2 className="m-0 mt-2 text-lg font-bold leading-snug tracking-[0.02em] group-hover:text-red">{item.title}</h2>
                      {item.summary ? <p className="mt-2 text-sm leading-6 text-muted">{item.summary}</p> : null}
                    </div>
                  </Link>
                </article>
              ))}
            </div>
          )}
        </section>

        <aside className="space-y-5 md:sticky md:top-6 md:self-start">
          <section className="border-2 border-red bg-paper p-5">
            <p className="m-0 text-xs font-bold tracking-[0.2em] text-red">PI AGENT</p>
            <h2 className="m-0 mt-2 text-2xl font-black">今日读法</h2>
            <div className="mt-4 space-y-3">
              {digest.starterQuestions.map((question) => (
                <p key={question} className="m-0 border-l-4 border-red pl-3 text-sm leading-6 text-ink">
                  {question}
                </p>
              ))}
              {digest.starterQuestions.length === 0 ? <p className="m-0 text-sm text-muted">等待新闻数据生成读法。</p> : null}
            </div>
          </section>

          <section className="border border-rule p-5">
            <h2 className="m-0 text-lg font-bold">注意力线索</h2>
            <div className="mt-4 space-y-4">
              {digest.attentionLanes.slice(0, 5).map((lane) => (
                <div key={lane.label} className="border-t border-rule pt-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-bold text-red">{lane.label}</span>
                    <span className="font-sans text-xs text-muted">{lane.articleIds.length} 篇</span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-muted">{lane.why}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="border border-rule p-5">
            <h2 className="m-0 text-lg font-bold">热词</h2>
            <div className="mt-4 flex flex-wrap gap-2">
              {digest.hotKeywords.slice(0, 12).map((term) => (
                <span key={term.name} className="tag">
                  {term.name} / {term.weight}
                </span>
              ))}
            </div>
          </section>

          <section className="border border-rule p-5">
            <h2 className="m-0 text-lg font-bold">来源分布</h2>
            <div className="mt-4 space-y-2">
              {digest.sourceCounts.slice(0, 8).map((source) => (
                <div key={source.name} className="flex items-center justify-between gap-3 text-sm">
                  <span className="truncate text-muted">{source.name}</span>
                  <span className="font-sans font-bold text-ink">{source.count}</span>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </main>
    </div>
  );
}
