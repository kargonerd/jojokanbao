import { createHash } from "node:crypto";
import type { UnavailablePageReason } from "../types.js";

export interface PageArticle {
  articleId: string;
  sourceId: string;
  title: string;
  canonicalUrl: string;
  captureUrl: string;
  publishedAt: string;
  needsBody: boolean;
  captureRevision?: string;
  unsupportedMediaRefreshHours?: number;
}

export interface PageCaptureStateRow {
  fingerprint?: string;
  lastAttempt?: string;
  capturedAt?: string;
  httpStatus?: number;
  error?: string | null;
  unavailableReason?: UnavailablePageReason;
  rawPageObject?: string;
}

export interface PageCaptureState {
  formatVersion: "jojo-page-capture-state/1";
  updatedAt?: string;
  articles: Record<string, PageCaptureStateRow>;
}

export function articleFingerprint(article: PageArticle): string {
  const identity = `${article.captureUrl}\0${article.title}\0${article.publishedAt}`;
  return createHash("sha256").update(article.captureRevision ? `${identity}\0${article.captureRevision}` : identity).digest("hex");
}

function timestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function pendingArticles(
  articles: readonly PageArticle[],
  stateBySource: ReadonlyMap<string, PageCaptureState>,
  options: { now: Date; retentionDays: number; refreshHours: number; retryHours: number },
): PageArticle[] {
  if (options.retentionDays <= 0 || options.refreshHours <= 0 || options.retryHours <= 0) {
    throw new Error("Capture retention and retry intervals must be positive");
  }
  const cutoff = options.now.valueOf() - options.retentionDays * 86_400_000;
  return articles.filter((article) => {
    if (article.unsupportedMediaRefreshHours !== undefined
      && (!Number.isFinite(article.unsupportedMediaRefreshHours) || article.unsupportedMediaRefreshHours <= 0)) {
      throw new Error("Unsupported-media refresh interval must be positive");
    }
    const published = timestamp(article.publishedAt);
    if (published === undefined || published < cutoff) return false;
    const previous = stateBySource.get(article.sourceId)?.articles[article.articleId];
    if (!previous || previous.fingerprint !== articleFingerprint(article)) return true;
    const lastAttempt = timestamp(previous.lastAttempt);
    if (lastAttempt === undefined) return true;
    const succeeded = previous.error == null && previous.rawPageObject !== undefined;
    const waitHours = previous.unavailableReason === "UnsupportedMedia"
      && article.unsupportedMediaRefreshHours !== undefined
      ? article.unsupportedMediaRefreshHours
      : succeeded
        ? options.refreshHours
        : options.retryHours;
    return options.now.valueOf() - lastAttempt >= waitHours * 3_600_000;
  }).sort((left, right) => Number(right.needsBody) - Number(left.needsBody)
    || right.publishedAt.localeCompare(left.publishedAt)
    || left.articleId.localeCompare(right.articleId));
}

export function selectRunArticles<T extends PageArticle>(
  articles: readonly T[],
  pending: readonly T[],
  options: { now: Date; processWindowHours: number },
): { articles: T[]; recoveryArticleIds: Set<string> } {
  if (!Number.isFinite(options.processWindowHours) || options.processWindowHours <= 0) {
    throw new Error("Process window must be positive");
  }
  const cutoff = options.now.valueOf() - options.processWindowHours * 3_600_000;
  const pendingIds = new Set(pending.map((article) => article.articleId));
  const recoveryArticleIds = new Set<string>();
  const selected = articles.filter((article) => {
    const published = timestamp(article.publishedAt);
    if (published !== undefined && published >= cutoff) return true;
    if (!pendingIds.has(article.articleId)) return false;
    recoveryArticleIds.add(article.articleId);
    return true;
  });
  return { articles: selected, recoveryArticleIds };
}
