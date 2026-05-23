type ScrapbookItem = {
  id: string;
  reason: string;
  score: number;
  relatedNews: { id: string; title: string; publishedAt: string };
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
  highlight: { id: string };
  createdAt: string;
  displayName?: string | null;
};

import HighlightClient from "./HighlightClient";

type NewsDetail = {
  news: {
    id: string;
    title: string;
    content: string;
    publishedAt: string;
    source: { name: string };
  };
  scrapbookItems: ScrapbookItem[];
  highlights: Highlight[];
  comments: Comment[];
};

async function fetchNews(id: string): Promise<NewsDetail | null> {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_BASE}/news/${id}`, {
    cache: "no-store"
  });
  if (!res.ok) return null;
  return res.json();
}

export default async function NewsDetailPage({ params }: { params: { id: string } }) {
  const data = await fetchNews(params.id);
  if (!data) return <div className="p-6">未找到新闻</div>;

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <main className="mx-auto w-full max-w-4xl px-6 py-10">
        <div className="text-xs text-zinc-500">{data.news.source?.name}</div>
        <h1 className="mt-2 text-3xl font-semibold">{data.news.title}</h1>
        <div className="mt-4 whitespace-pre-line text-sm text-zinc-700">
          {data.news.content}
        </div>

        <section className="mt-10">
          <h2 className="text-xl font-semibold">合订本</h2>
          <div className="mt-4 grid gap-4">
            {data.scrapbookItems.length === 0 && (
              <div className="text-sm text-zinc-500">暂无合订本候选</div>
            )}
            {data.scrapbookItems.map((item) => (
              <div key={item.id} className="rounded-lg border border-zinc-200 bg-white p-4">
                <div className="text-xs text-zinc-500">反差评分 {item.score.toFixed(2)}</div>
                <div className="mt-2 text-sm font-semibold">{item.relatedNews.title}</div>
                <div className="mt-2 text-sm text-zinc-600">{item.reason}</div>
              </div>
            ))}
          </div>
        </section>

        <HighlightClient
          newsId={data.news.id}
          content={data.news.content}
          highlights={data.highlights}
          comments={data.comments}
        />
      </main>
    </div>
  );
}
