import { CONTENT_SEARCH_API } from "@jojo/content";

export interface ArchiveSearchResult {
  title: string;
  content: string;
  date: string;
  page: number;
  datasetId: string;
}

export interface ArchiveSearchResponse {
  results: ArchiveSearchResult[];
  total: number;
}

interface SearchArchiveOptions {
  keyword: string;
  page?: number;
  size?: number;
  signal?: AbortSignal;
}

// The unified endpoint keeps the printed page under `metadata.page`, unlike the
// legacy archive endpoint which returned it at the top level.
function readPage(metadata: unknown): number {
  const value = (metadata ?? {}) as Record<string, unknown>;
  return Math.max(0, Number(value.page) || 0);
}

export async function searchArchive({
  keyword,
  page = 1,
  size = 10,
  signal,
}: SearchArchiveOptions): Promise<ArchiveSearchResponse> {
  const response = await fetch(CONTENT_SEARCH_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: keyword.trim(),
      page,
      size,
      types: ["newspaper", "magazine"],
    }),
    signal,
  });
  if (!response.ok) throw new Error(`Search failed with HTTP ${response.status}`);

  const payload = await response.json() as {
    data?: { results?: unknown[]; total?: unknown };
  };
  if (!Array.isArray(payload.data?.results) || !Number.isFinite(payload.data?.total)) {
    throw new Error("Search returned an invalid response");
  }

  return {
    results: payload.data.results.map((item) => {
      const result = (item ?? {}) as Record<string, unknown>;
      return {
        // The unified endpoint already returns plain text and exposes
        // highlighted fragments separately under `titleHighlights`/`highlights`.
        title: String(result.title ?? ""),
        content: String(result.content ?? ""),
        date: String(result.date ?? ""),
        page: readPage(result.metadata),
        datasetId: String(result.datasetId ?? "rmrb"),
      };
    }),
    total: Math.max(0, Number(payload.data.total)),
  };
}
