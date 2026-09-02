import type { TimesDeliveryArticle } from "@jojo/content";

export function exactArticleTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "时间未知" : new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function relativeArticleTime(value: string): string {
  const timestamp = new Date(value).valueOf();
  if (Number.isNaN(timestamp)) return "时间未知";
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (elapsedMinutes < 1) return "刚刚";
  if (elapsedMinutes < 60) return `${elapsedMinutes}分钟前`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}小时前`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) return `${elapsedDays}天前`;
  if (elapsedDays < 30) return `${Math.floor(elapsedDays / 7)}周前`;
  if (elapsedDays < 365) return `${Math.floor(elapsedDays / 30)}个月前`;
  return `${Math.floor(elapsedDays / 365)}年前`;
}

export function publisherUpdatedAt(
  article: Pick<TimesDeliveryArticle, "publishedAt" | "updatedAt">,
): string | undefined {
  if (!article.updatedAt) return undefined;
  const published = new Date(article.publishedAt).valueOf();
  const updated = new Date(article.updatedAt).valueOf();
  return Number.isFinite(published) && Number.isFinite(updated) && updated > published
    ? article.updatedAt
    : undefined;
}
