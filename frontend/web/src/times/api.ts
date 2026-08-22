import { requestJson } from "../api/client";

const TIMES_API_ROOT = "/api/v1/times";

async function request<T>(path: string): Promise<T> {
  const { authClient } = await import("../account/auth");
  const { data, error } = await authClient.auth.getSession();
  if (error) throw error;
  const token = data.session?.access_token;
  if (!token) throw new Error("请先登录后使用时事");
  return requestJson<T>(`${TIMES_API_ROOT}${path}`, { token });
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

export type TimesStats = { total: number; sourceCount: number };

export const timesApi = {
  listNews: () => request<TimesNewsItem[]>("/news?limit=100"),
  getStats: () => request<TimesStats>("/stats"),
  getNews: (newsId: string) => request<TimesNewsItem>(`/news/${encodeURIComponent(newsId)}`),
};
