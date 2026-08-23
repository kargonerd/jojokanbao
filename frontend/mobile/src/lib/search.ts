import { ARCHIVE_SEARCH_API, stripSearchHighlights } from "@jojo/content";

export interface ArchiveSearchResult {
  title: string;
  content: string;
  date: string;
  page: number;
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

export async function searchArchive({
  keyword,
  page = 1,
  size = 10,
  signal,
}: SearchArchiveOptions): Promise<ArchiveSearchResponse> {
  const query = new URLSearchParams({ keyword: keyword.trim(), page: String(page), size: String(size) });
  const response = await fetch(`${ARCHIVE_SEARCH_API}?${query}`, { signal });
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
        title: stripSearchHighlights(String(result.title ?? "")),
        content: stripSearchHighlights(String(result.content ?? "")),
        date: String(result.date ?? ""),
        page: Math.max(0, Number(result.page) || 0),
      };
    }),
    total: Math.max(0, Number(payload.data.total)),
  };
}
