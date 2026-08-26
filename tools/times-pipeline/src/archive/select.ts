import { createHash } from "node:crypto";

export interface ArchiveArticle {
  articleId: string;
  sourceId: string;
  title: string;
  canonicalUrl: string;
  captureUrl: string;
  publishedAt: string;
  needsBody?: boolean;
}

export interface ArchiveStateRow {
  fingerprint?: string;
  lastAttempt?: string;
  capturedAt?: string;
  httpStatus?: number;
  error?: string | null;
  waczObject?: string;
}

export interface ArchiveState {
  formatVersion: "jojo-web-archive-state/1";
  updatedAt?: string;
  articles: Record<string, ArchiveStateRow>;
}

export function articleFingerprint(article: ArchiveArticle): string {
  return createHash("sha256")
    .update(`${article.captureUrl}\0${article.title}\0${article.publishedAt}`)
    .digest("hex");
}

function parsedDate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const timestamp = new Date(value).valueOf();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export function selectArticlesForCapture(
  articles: ArchiveArticle[],
  state: ArchiveState,
  options: {
    now: Date;
    retentionDays: number;
    maximumPages: number;
    refreshHours: number;
    retryHours: number;
  },
): ArchiveArticle[] {
  if (options.maximumPages < 0 || options.refreshHours <= 0 || options.retryHours <= 0) {
    throw new Error("Archive limits and refresh intervals must be valid");
  }
  if (options.maximumPages === 0) return [];
  const cutoff = options.now.valueOf() - options.retentionDays * 86_400_000;
  const ranked: Array<{ rank: number; published: number; article: ArchiveArticle }> = [];
  for (const article of articles) {
    const published = parsedDate(article.publishedAt);
    if (published === undefined || published < cutoff) continue;
    const previous = state.articles[article.articleId];
    let rank: number;
    if (!previous) {
      rank = 0;
    } else if (previous.fingerprint !== articleFingerprint(article)) {
      rank = 1;
    } else {
      const lastAttempt = parsedDate(previous.lastAttempt);
      const succeeded = previous.error == null
        && previous.httpStatus !== undefined
        && previous.httpStatus >= 200
        && previous.httpStatus < 400;
      const waitHours = succeeded ? options.refreshHours : options.retryHours;
      if (lastAttempt !== undefined && options.now.valueOf() - lastAttempt < waitHours * 3_600_000) continue;
      rank = succeeded ? 3 : 2;
    }
    ranked.push({ rank: rank + (article.needsBody ? 0 : 10), published, article });
  }
  ranked.sort((left, right) => left.rank - right.rank
    || right.published - left.published
    || left.article.articleId.localeCompare(right.article.articleId));
  const selected: ArchiveArticle[] = [];
  const selectedIds = new Set<string>();
  const representedSources = new Set<string>();
  for (const row of ranked) {
    if (representedSources.has(row.article.sourceId)) continue;
    selected.push(row.article);
    selectedIds.add(row.article.articleId);
    representedSources.add(row.article.sourceId);
    if (selected.length === options.maximumPages) return selected;
  }
  for (const row of ranked) {
    if (selectedIds.has(row.article.articleId)) continue;
    selected.push(row.article);
    if (selected.length === options.maximumPages) break;
  }
  return selected;
}
