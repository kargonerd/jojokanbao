const TIMES_API_BASE = (import.meta.env.VITE_TIMES_API_BASE || "").replace(/\/$/, "");

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${TIMES_API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`时事服务返回 HTTP ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export type TimesNewsItem = {
  id: string;
  title: string;
  summary?: string | null;
  content?: string | null;
  url?: string | null;
  publishedAt: string;
  source?: { name: string } | null;
};

export type TimesDigest = {
  articleCount: number;
  hotKeywords: { name: string; weight: number }[];
  attentionLanes: { label: string; why: string; articleIds: string[] }[];
  starterQuestions: string[];
  sourceCounts: { name: string; count: number }[];
};

export type TimesStats = { total: number; sourceCount: number };

export type TimesNewsDetail = {
  news: TimesNewsItem;
  scrapbookItems?: Array<{
    id: string;
    score: number;
    reason: string;
    relatedNews: TimesNewsItem;
  }>;
};

export type TimesBriefing = {
  readingQuestions?: string[];
  historicalContext?: Array<TimesNewsItem & { score: number; reason: string }>;
  entities?: Array<{ name: string; type: string }>;
  timeline?: Array<{ date: string; detail: string }>;
};

export type TimesSource = { id: string; name: string; rssUrl: string };

export const timesApi = {
  listNews: () => request<TimesNewsItem[]>("/news?limit=100"),
  getDigest: () => request<TimesDigest>("/ai/digest?limit=100"),
  getStats: () => request<TimesStats>("/stats"),
  getNews: (newsId: string) => request<TimesNewsDetail>(`/news/${encodeURIComponent(newsId)}`),
  getBriefing: (newsId: string) => request<TimesBriefing>(`/ai/briefing/${encodeURIComponent(newsId)}`),
  ask: (newsId: string, question: string) => request<{ answer: string }>("/ai/ask", {
    method: "POST",
    body: JSON.stringify({ newsId, question }),
  }),
  listSources: () => request<TimesSource[]>("/sources"),
  createSource: (name: string, rssUrl: string) => request<TimesSource>("/sources", {
    method: "POST",
    body: JSON.stringify({ name, rssUrl }),
  }),
  deleteSource: (sourceId: string) => request<TimesSource>(`/sources/${encodeURIComponent(sourceId)}`, { method: "DELETE" }),
  fetchRss: () => request<unknown>("/jobs/fetch-rss", { method: "POST" }),
};
