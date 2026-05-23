import Link from "next/link";

export default function Home() {
  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-4">
          <div className="text-xl font-semibold">JOJO旧闻</div>
          <nav className="flex items-center gap-4 text-sm text-zinc-600">
            <Link href="/admin/sources">源管理</Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl px-6 py-10">
        <section className="mb-8">
          <h1 className="text-3xl font-semibold">今日旧闻</h1>
          <p className="mt-2 text-zinc-600">
            看完新闻，自动生成合订本，形成前后反差与历史对照。
          </p>
        </section>

        <section className="grid gap-6">
          <article className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
            <div className="text-xs text-zinc-500">示例 · 刚刚</div>
            <h2 className="mt-2 text-xl font-semibold">
              雷军：AI 时代每个人只需工作两个小时
            </h2>
            <p className="mt-2 text-sm text-zinc-600">
              摘要示例：关于 AI 提升生产力的最新发言……
            </p>
            <div className="mt-4">
              <Link
                className="text-sm font-medium text-zinc-900 underline underline-offset-4"
                href="/news/1"
              >
                查看详情
              </Link>
            </div>
          </article>
        </section>
      </main>
    </div>
  );
}
