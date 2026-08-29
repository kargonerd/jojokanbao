export interface SourceBatch<T> {
  sourceId: string;
  articles: T[];
}

export function groupArticlesBySource<T extends { sourceId: string }>(articles: readonly T[]): SourceBatch<T>[] {
  const grouped = new Map<string, T[]>();
  for (const article of articles) {
    const rows = grouped.get(article.sourceId) ?? [];
    rows.push(article);
    grouped.set(article.sourceId, rows);
  }
  return [...grouped].map(([sourceId, rows]) => ({ sourceId, articles: rows }));
}

export function rotatingSourceProbes<T extends { sourceId: string }>(
  articles: readonly T[],
  offsets: Map<string, number>,
): T[] {
  return groupArticlesBySource(articles).map((batch) => {
    const offset = offsets.get(batch.sourceId) ?? 0;
    offsets.set(batch.sourceId, offset + 1);
    return batch.articles[offset % batch.articles.length]!;
  });
}

export function proxyTailSourceIds<T extends { sourceId: string }>(
  articles: readonly T[],
  maximumArticlesPerSource: number,
): Set<string> {
  if (!Number.isInteger(maximumArticlesPerSource) || maximumArticlesPerSource < 0) {
    throw new Error("Proxy tail size must be a non-negative integer");
  }
  if (maximumArticlesPerSource === 0) return new Set();
  return new Set(groupArticlesBySource(articles)
    .filter((batch) => batch.articles.length <= maximumArticlesPerSource)
    .map((batch) => batch.sourceId));
}

export function untriedProxyArticles<T extends { articleId: string; sourceId: string }>(
  articles: readonly T[],
  sourceIds: ReadonlySet<string>,
  attempts: ReadonlyMap<string, ReadonlySet<string>>,
  proxyCandidate: string,
): T[] {
  return articles.filter((article) => sourceIds.has(article.sourceId)
    && !attempts.get(article.articleId)?.has(proxyCandidate));
}

export async function mapSourceBatches<T extends { sourceId: string }, R>(
  articles: readonly T[],
  concurrency: number,
  work: (batch: SourceBatch<T>) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Source concurrency must be a positive integer");
  const batches = groupArticlesBySource(articles);
  const results = new Array<R>(batches.length);
  let cursor = 0;
  const consume = async (): Promise<void> => {
    while (cursor < batches.length) {
      const index = cursor++;
      results[index] = await work(batches[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, consume));
  return results;
}
