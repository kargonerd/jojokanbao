import { createHash } from "node:crypto";

export interface PageArticle {
  articleId: string;
  sourceId: string;
  title: string;
  canonicalUrl: string;
  captureUrl: string;
  publishedAt: string;
  needsBody: boolean;
}

export interface PageCaptureStateRow {
  fingerprint?: string;
  lastAttempt?: string;
  capturedAt?: string;
  httpStatus?: number;
  error?: string | null;
  rawPageObject?: string;
}

export interface PageCaptureState {
  formatVersion: "jojo-page-capture-state/1";
  updatedAt?: string;
  articles: Record<string, PageCaptureStateRow>;
}

export function articleFingerprint(article: PageArticle): string {
  return createHash("sha256").update(`${article.captureUrl}\0${article.title}\0${article.publishedAt}`).digest("hex");
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
    const published = timestamp(article.publishedAt);
    if (published === undefined || published < cutoff) return false;
    const previous = stateBySource.get(article.sourceId)?.articles[article.articleId];
    if (!previous || previous.fingerprint !== articleFingerprint(article)) return true;
    const lastAttempt = timestamp(previous.lastAttempt);
    if (lastAttempt === undefined) return true;
    const succeeded = previous.error == null && previous.rawPageObject !== undefined;
    const waitHours = succeeded ? options.refreshHours : options.retryHours;
    return options.now.valueOf() - lastAttempt >= waitHours * 3_600_000;
  }).sort((left, right) => Number(right.needsBody) - Number(left.needsBody)
    || right.publishedAt.localeCompare(left.publishedAt)
    || left.articleId.localeCompare(right.articleId));
}
