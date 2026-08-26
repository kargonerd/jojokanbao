const htmlCache = new Map<string, Promise<string>>();

export async function fetchHtml(sourceId: string, url: string): Promise<string> {
  const cached = htmlCache.get(url);
  if (cached) return cached;
  const pending = (async () => {
    const response = await fetch(url, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "JOJO-Times-Offline/2.0 (+https://jojokanbao.cn)",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(70_000),
    });
    if (!response.ok) throw new Error(`${sourceId}: HTML page returned HTTP ${response.status}: ${url}`);
    return response.text();
  })();
  htmlCache.set(url, pending);
  try {
    return await pending;
  } catch (error) {
    htmlCache.delete(url);
    throw error;
  }
}

export async function mapLimit<T>(
  values: string[],
  concurrency: number,
  work: (value: string) => Promise<T | undefined>,
): Promise<T[]> {
  const results: T[] = [];
  let cursor = 0;
  async function consume(): Promise<void> {
    while (cursor < values.length) {
      const value = values[cursor++];
      if (!value) return;
      const result = await work(value);
      if (result !== undefined) results.push(result);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, consume));
  return results;
}
