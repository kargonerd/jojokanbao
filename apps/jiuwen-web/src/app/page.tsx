import Link from "next/link";

export default function Home() {
  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="h-[58px] flex items-center border-b border-rule-dark px-6">
        <h1 className="text-lg font-bold text-red tracking-wider m-0">JOJO旧闻</h1>
        <nav className="ml-auto flex items-center gap-4 text-sm">
          <Link href="/admin/sources" className="font-bold text-ink no-underline hover:text-red transition-colors">源管理</Link>
        </nav>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-10">
        <section className="mb-10">
          <h2 className="text-3xl font-bold text-ink tracking-wider m-0">今日旧闻</h2>
          <p className="mt-2 text-sm text-muted">看完新闻，自动生成合订本，形成前后反差与历史对照。</p>
        </section>

        <section className="space-y-4">
          <article className="border-2 border-red p-6 bg-paper transition-all duration-[180ms] hover:-translate-y-0.5 hover:shadow-[4px_4px_0_rgba(139,26,26,.14)]">
            <div className="text-xs text-muted tracking-wider">示例 · 刚刚</div>
            <h3 className="mt-2 text-xl font-bold text-ink tracking-wide">
              雷军：AI 时代每个人只需工作两个小时
            </h3>
            <p className="mt-2 text-sm text-muted leading-relaxed">
              摘要示例：关于 AI 提升生产力的最新发言……
            </p>
            <Link href="/news/1" className="inline-block mt-4 text-sm font-bold text-red hover:text-red-dark">
              查看详情 →
            </Link>
          </article>
        </section>
      </main>
    </div>
  );
}
