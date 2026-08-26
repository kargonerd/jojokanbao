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
