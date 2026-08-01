const OLDS_API_BASE = (import.meta.env.VITE_OLDS_API_BASE || "").replace(/\/$/, "");

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${OLDS_API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`旧闻服务返回 HTTP ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export type OldsNewsItem = {
  id: string;
  title: string;
  summary?: string | null;
  content?: string | null;
  url?: string | null;
  publishedAt: string;
  source?: { name: string } | null;
};

export type OldsDigest = {
  articleCount: number;
  hotKeywords: { name: string; weight: number }[];
  attentionLanes: { label: string; why: string; articleIds: string[] }[];
  starterQuestions: string[];
  sourceCounts: { name: string; count: number }[];
};

export type OldsStats = { total: number; sourceCount: number };

export type OldsNewsDetail = {
  news: OldsNewsItem;
  scrapbookItems?: Array<{
    id: string;
    score: number;
    reason: string;
    relatedNews: OldsNewsItem;
  }>;
};

export type OldsBriefing = {
  readingQuestions?: string[];
  oldContext?: Array<OldsNewsItem & { score: number; reason: string }>;
  entities?: Array<{ name: string; type: string }>;
  timeline?: Array<{ date: string; detail: string }>;
};

export type OldsSource = { id: string; name: string; rssUrl: string };

export const oldsApi = {
  listNews: () => request<OldsNewsItem[]>("/news?limit=100"),
  getDigest: () => request<OldsDigest>("/ai/digest?limit=100"),
  getStats: () => request<OldsStats>("/stats"),
  getNews: (newsId: string) => request<OldsNewsDetail>(`/news/${encodeURIComponent(newsId)}`),
  getBriefing: (newsId: string) => request<OldsBriefing>(`/ai/briefing/${encodeURIComponent(newsId)}`),
  ask: (newsId: string, question: string) => request<{ answer: string }>("/ai/ask", {
    method: "POST",
    body: JSON.stringify({ newsId, question }),
  }),
  listSources: () => request<OldsSource[]>("/sources"),
  createSource: (name: string, rssUrl: string) => request<OldsSource>("/sources", {
    method: "POST",
    body: JSON.stringify({ name, rssUrl }),
  }),
  deleteSource: (sourceId: string) => request<OldsSource>(`/sources/${encodeURIComponent(sourceId)}`, { method: "DELETE" }),
  fetchRss: () => request<unknown>("/jobs/fetch-rss", { method: "POST" }),
};
