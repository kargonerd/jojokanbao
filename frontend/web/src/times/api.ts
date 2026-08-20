import { requestJson } from "../api/client";

const TIMES_API_ROOT = "/api/v1/times";

async function request<T>(path: string, options?: { method?: "POST"; body?: unknown }): Promise<T> {
  return requestJson<T>(`${TIMES_API_ROOT}${path}`, options);
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

export const timesApi = {
  listNews: () => request<TimesNewsItem[]>("/news?limit=100"),
  getDigest: () => request<TimesDigest>("/ai/digest?limit=100"),
  getStats: () => request<TimesStats>("/stats"),
  getNews: (newsId: string) => request<TimesNewsDetail>(`/news/${encodeURIComponent(newsId)}`),
  getBriefing: (newsId: string) => request<TimesBriefing>(`/ai/briefing/${encodeURIComponent(newsId)}`),
  ask: (newsId: string, question: string) => request<{ answer: string }>("/ai/ask", {
    method: "POST",
    body: { newsId, question },
  }),
};
