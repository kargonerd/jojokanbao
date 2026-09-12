import { Fragment, useState, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import axios from "axios";
import {
  ARCHIVE_PUBLICATIONS,
  ARCHIVE_PUBLICATION_BY_ID,
  ARCHIVE_PUBLICATION_NAMES,
  ARCHIVE_SEARCH_API,
  CONTENT_SEARCH_API,
  searchResultQuote,
  searchResultTitle,
  withSearchLocation,
  type ArchivePublicationName,
} from "@jojo/content";
import { Button, Tag, Pagination, LoadingSpinner, DateRangePicker, Select, type DateRangeValue } from "@jojo/ui";
import { useAccountSessionStore } from "../../account/session";
import { getLatestRmrbAvailableDate } from "../dateAvailability";
import { archiveIssuePath } from "../../routes";
import { rollout } from "../../rollout";
import { loadCatalog } from "../../rag/content";
import { isContentVisible } from "../../rag/contentVisibility";

type SearchContentType = "periodical" | "book";

interface SearchContentTypeOption {
  value: SearchContentType;
  label: string;
  sourceLabel: string;
  selectLabel: string;
  allLabel: string;
  types: readonly string[];
  supportsDate: boolean;
  supportsSort: boolean;
}

interface SearchDatasetOption {
  id: string;
  label: string;
}

interface SearchResult {
  title: string;
  fullTitle?: string;
  content: string;
  preview?: string;
  date: string;
  page: number;
  type: string;
  datasetId: string;
  itemId: string;
  source: string;
  itemTitle: string;
  chapterId: string;
  ellipsis: boolean;
}

interface UnifiedSearchResult {
  title?: unknown;
  content?: unknown;
  date?: unknown;
  type?: unknown;
  datasetId?: unknown;
  itemId?: unknown;
  source?: unknown;
  metadata?: unknown;
  titleHighlights?: unknown;
  highlights?: unknown;
}

const SORT_OPTIONS = [
  { value: "", label: "默认排序" },
  { value: "match", label: "最佳匹配" },
  { value: "timeAsc", label: "时间升序" },
  { value: "timeDesc", label: "时间降序" },
] as const;

const EARLIEST_AVAILABLE_DATE = "19460515";
const SEARCH_PERIODS = [
  { value: "new-democratic", label: "新民主主义革命", startDate: "19460515", endDate: "19490930" },
  { value: "socialist-construction", label: "社会主义革命和建设", startDate: "19491001", endDate: "19781217" },
  { value: "great-leap-forward", label: "大跃进", startDate: "19580101", endDate: "19601231" },
  { value: "cultural-revolution", label: "“文革”十年", startDate: "19660516", endDate: "19761006" },
  { value: "reform-opening", label: "改革开放新时期", startDate: "19781218", endDate: "20121107" },
  { value: "new-era", label: "新时代", startDate: "20121108", endDate: "" },
] as const;

const SEARCH_CONTENT_TYPES: readonly SearchContentTypeOption[] = [
  {
    value: "periodical",
    label: "报刊",
    sourceLabel: "报刊",
    selectLabel: "选择报刊",
    allLabel: "全部报刊",
    types: ["newspaper"],
    supportsDate: true,
    supportsSort: true,
  },
  {
    value: "book",
    label: "书籍",
    sourceLabel: "书目",
    selectLabel: "选择书籍",
    allLabel: "全部书籍",
    types: ["book"],
    supportsDate: false,
    supportsSort: false,
  },
];

const SEARCH_CONTENT_TYPE_BY_ID = Object.fromEntries(
  SEARCH_CONTENT_TYPES.map((option) => [option.value, option]),
) as Record<SearchContentType, SearchContentTypeOption>;

const PERIODICAL_DATASETS: readonly SearchDatasetOption[] = ARCHIVE_PUBLICATIONS
  .filter((publication) => publication.id === "rmrb")
  .map((publication) => ({ id: publication.id, label: publication.title }));

function renderHighlighted(value: string, replaceBreaks: boolean, strong: boolean): ReactNode[] {
  let highlighted = false;
  return value.split(/(@highlight@|@\/highlight@|\n)/g).flatMap((part, index) => {
    if (part === "@highlight@") {
      highlighted = true;
      return [];
    }
    if (part === "@/highlight@") {
      highlighted = false;
      return [];
    }
    if (part === "\n" && replaceBreaks) return [<br key={`break-${index}`} />];
    if (!part) return [];
    if (!highlighted) return [<Fragment key={`text-${index}`}>{part}</Fragment>];
    return strong
      ? [<strong key={`highlight-${index}`} className="search-highlight">{part}</strong>]
      : [<span key={`highlight-${index}`} className="search-highlight">{part}</span>];
  });
}

function parsePage(value: string | null): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function normalizeSort(value: string | null): string {
  return SORT_OPTIONS.some((option) => option.value === value) ? value! : "";
}

function normalizeContentType(value: string | null): SearchContentType {
  return value === "book" ? "book" : "periodical";
}

function normalizeDatasetId(value: string | null, contentType: SearchContentType): string {
  const datasetId = (value || "").trim();
  if (!datasetId) return "";
  if (contentType === "book") return datasetId;
  return PERIODICAL_DATASETS.some((dataset) => dataset.id === datasetId) ? datasetId : "";
}

function formatSearchApiDate(value: string): string {
  return value.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
}

function convertUnifiedHighlight(value: string): string {
  return value.replaceAll("<mark>", "@highlight@").replaceAll("</mark>", "@/highlight@");
}

function normalizeUnifiedResult(result: UnifiedSearchResult): SearchResult {
  const metadata = result.metadata && typeof result.metadata === "object"
    ? result.metadata as Record<string, unknown>
    : {};
  const titleHighlights = Array.isArray(result.titleHighlights)
    ? result.titleHighlights.filter((value): value is string => typeof value === "string")
    : [];
  const contentHighlights = Array.isArray(result.highlights)
    ? result.highlights.filter((value): value is string => typeof value === "string")
    : [];
  return {
    title: convertUnifiedHighlight(titleHighlights[0] ?? String(result.title ?? "")),
    fullTitle: String(result.title ?? ""),
    content: String(result.content ?? ""),
    preview: contentHighlights.length > 0
      ? convertUnifiedHighlight(contentHighlights.join("\n…\n"))
      : undefined,
    date: String(result.date ?? ""),
    page: Number(metadata.page) || 0,
    type: String(result.type ?? ""),
    datasetId: String(result.datasetId ?? ""),
    itemId: String(result.itemId ?? ""),
    source: String(result.source ?? ""),
    itemTitle: String(metadata.itemTitle ?? ""),
    chapterId: String(metadata.chapterId ?? ""),
    ellipsis: true,
  };
}

function buildSearchParams({
  keyword,
  page,
  sort,
  startDate,
  endDate,
  contentType,
  datasetId,
}: {
  keyword: string;
  page: number;
  sort: string;
  startDate: string;
  endDate: string;
  contentType?: SearchContentType;
  datasetId?: string;
}): URLSearchParams {
  const query = new URLSearchParams({ keyword: keyword.trim() });
  if (page > 1) query.set("page", String(page));
  if (sort && (!contentType || SEARCH_CONTENT_TYPE_BY_ID[contentType].supportsSort)) query.set("sort", sort);
  if (contentType === "book") query.set("type", "book");
  if (datasetId) query.set("dataset", datasetId);
  if (startDate && endDate && (!contentType || SEARCH_CONTENT_TYPE_BY_ID[contentType].supportsDate)) {
    query.set("startDate", startDate);
    query.set("endDate", endDate);
  }
  return query;
}

function findBookDataset(result: SearchResult, bookDatasets: readonly SearchDatasetOption[]): SearchDatasetOption | undefined {
  if (result.type !== "book") return undefined;
  // The search index may still use legacy book-* IDs while delivery uses slugs.
  return bookDatasets.find((dataset) => dataset.id === result.datasetId)
    || bookDatasets.find((dataset) => dataset.label === result.source);
}

function unifiedResultPath(result: SearchResult, bookDatasets: readonly SearchDatasetOption[]): string {
  if (result.type === "book" && result.datasetId && result.itemId) {
    const canonicalDatasetId = findBookDataset(result, bookDatasets)?.id
      || result.datasetId;
    const itemPrefix = `${result.datasetId}:`;
    const itemKey = result.itemId.startsWith(itemPrefix)
      ? result.itemId.slice(itemPrefix.length)
      : result.itemId;
    const chapter = result.chapterId ? `?chapter=${encodeURIComponent(result.chapterId)}` : "";
    return `/book/${encodeURIComponent(canonicalDatasetId)}/${encodeURIComponent(itemKey)}${chapter}`;
  }
  if (ARCHIVE_PUBLICATION_NAMES.includes(result.datasetId as ArchivePublicationName)) {
    const issueId = (result.itemId.split(":").at(-1) || result.date).replace(/\D/g, "");
    if (issueId) {
      const pageHash = result.page > 0 ? `#page-${result.page}` : "";
      return `${archiveIssuePath(result.datasetId as ArchivePublicationName, issueId)}${pageHash}`;
    }
  }
  return "/library";
}

function resultSourceLabel(result: SearchResult): string {
  if (result.type === "book") return result.itemTitle || result.source || "书籍";
  if (ARCHIVE_PUBLICATION_NAMES.includes(result.datasetId as ArchivePublicationName)) {
    return ARCHIVE_PUBLICATION_BY_ID[result.datasetId as ArchivePublicationName].title;
  }
  return result.source || "报刊";
}

export function SearchPage({
  platformRedesign = rollout.platformRedesign,
  openResultsInNewTab = true,
}: {
  platformRedesign?: boolean;
  openResultsInNewTab?: boolean;
}) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const [term, setTerm] = useState(params.get("keyword") || "");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(parsePage(params.get("page")));
  const [resultsPage, setResultsPage] = useState(page);
  const [sort, setSort] = useState(normalizeSort(params.get("sort")));
  const [startDate, setStartDate] = useState(params.get("startDate") || "");
  const [endDate, setEndDate] = useState(params.get("endDate") || "");
  const [contentType, setContentType] = useState<SearchContentType>(normalizeContentType(params.get("type")));
  const [datasetId, setDatasetId] = useState(normalizeDatasetId(
    params.get("dataset"),
    normalizeContentType(params.get("type")),
  ));
  const [bookDatasets, setBookDatasets] = useState<SearchDatasetOption[]>([]);
  const [bookCatalogReady, setBookCatalogReady] = useState(false);
  const [bookCatalogError, setBookCatalogError] = useState(false);
  const [catalogRetryToken, setCatalogRetryToken] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [beforeSearch, setBeforeSearch] = useState(!params.get("keyword"));
  const [retryToken, setRetryToken] = useState(0);
  const accountInitialized = useAccountSessionStore((state) => state.initialized);
  const userId = useAccountSessionStore((state) => state.userId);
  const signedIn = Boolean(userId);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrollToResultsRef = useRef(false);
  const requestIdRef = useRef(0);
  const pageSize = 10;
  const paramsKey = params.toString();
  const requestedContentType = normalizeContentType(params.get("type"));
  const activeBookDatasetsKey = requestedContentType === "book" ? JSON.stringify(bookDatasets) : "";
  const bookSearchReady = requestedContentType !== "book" || bookCatalogReady;
  const activeBookCatalogError = requestedContentType === "book" && bookCatalogError;
  const latestAvailableDate = getLatestRmrbAvailableDate();
  const disableUnavailableDate = (date: string) => date < EARLIEST_AVAILABLE_DATE || date > latestAvailableDate;

  useEffect(() => {
    if (!platformRedesign) return;
    setBookCatalogError(false);
    if (!accountInitialized) {
      setBookDatasets([]);
      setBookCatalogReady(false);
      return;
    }
    let active = true;
    setBookCatalogReady(false);
    void loadCatalog()
      .then((catalog) => {
        if (!active) return;
        setBookDatasets(catalog.datasets
          .filter((dataset) => (
            (dataset.type === "book" || dataset.type === "book-series")
            && dataset.publicationStatus !== "draft"
            && isContentVisible(dataset.access, signedIn)
          ))
          .map((dataset) => ({ id: dataset.datasetId, label: dataset.title }))
          .sort((left, right) => left.label.localeCompare(right.label, "zh-CN")));
      })
      .catch(() => {
        if (!active) return;
        setBookDatasets([]);
        setBookCatalogError(true);
      })
      .finally(() => {
        if (active) setBookCatalogReady(true);
      });
    return () => { active = false; };
  }, [accountInitialized, catalogRetryToken, platformRedesign, signedIn]);

  useEffect(() => {
    const nextContentType = platformRedesign ? normalizeContentType(params.get("type")) : "periodical";
    const option = SEARCH_CONTENT_TYPE_BY_ID[nextContentType];
    setTerm((params.get("keyword") || "").trim());
    setPage(parsePage(params.get("page")));
    setSort(option.supportsSort ? normalizeSort(params.get("sort")) : "");
    setStartDate(option.supportsDate ? params.get("startDate") || "" : "");
    setEndDate(option.supportsDate ? params.get("endDate") || "" : "");
    setContentType(nextContentType);
    setDatasetId(platformRedesign ? normalizeDatasetId(params.get("dataset"), nextContentType) : "");
  }, [paramsKey, platformRedesign]);

  useEffect(() => {
    const keyword = (params.get("keyword") || "").trim();
    const nextPage = parsePage(params.get("page"));
    const nextContentType = platformRedesign ? normalizeContentType(params.get("type")) : "periodical";
    const contentTypeOption = SEARCH_CONTENT_TYPE_BY_ID[nextContentType];
    const nextSort = contentTypeOption.supportsSort ? normalizeSort(params.get("sort")) : "";
    const nextDatasetId = platformRedesign
      ? normalizeDatasetId(params.get("dataset"), nextContentType)
      : "";
    const supportsDate = contentTypeOption.supportsDate;
    const nextStartDate = supportsDate ? params.get("startDate") || "" : "";
    const nextEndDate = supportsDate ? params.get("endDate") || "" : "";

    if (!keyword) {
      requestIdRef.current += 1;
      setBeforeSearch(true);
      setResults(null);
      setTotal(0);
      setError(null);
      setLoading(false);
      return;
    }

    if (platformRedesign && activeBookCatalogError) {
      requestIdRef.current += 1;
      setBeforeSearch(false);
      setResults(null);
      setTotal(0);
      setError(null);
      setLoading(false);
      return;
    }

    if (platformRedesign && nextContentType === "book" && !bookSearchReady) {
      setBeforeSearch(false);
      setLoading(true);
      setError(null);
      return;
    }

    if (platformRedesign && nextContentType === "book" && (
      bookDatasets.length === 0 || (nextDatasetId && !bookDatasets.some((dataset) => dataset.id === nextDatasetId))
    )) {
      requestIdRef.current += 1;
      setBeforeSearch(false);
      setResults([]);
      setTotal(0);
      setError(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    const requestId = ++requestIdRef.current;
    const requestParams: Record<string, string | number> = { keyword, page: nextPage, size: pageSize };
    if (nextSort) requestParams.sort = nextSort;
    if (nextStartDate && nextEndDate) {
      requestParams.startDate = formatSearchApiDate(nextStartDate);
      requestParams.endDate = formatSearchApiDate(nextEndDate);
    }

    setBeforeSearch(false);
    setLoading(true);
    setError(null);

    const selectedPeriodical = nextDatasetId
      && nextContentType === "periodical"
      ? ARCHIVE_PUBLICATION_BY_ID[nextDatasetId as ArchivePublicationName]
      : undefined;
    const selectedBook = nextDatasetId && nextContentType === "book"
      ? bookDatasets.find((dataset) => dataset.id === nextDatasetId)
      : undefined;
    const scopedBookDatasets = selectedBook ? [selectedBook] : bookDatasets;
    const unifiedTypes = selectedPeriodical
      ? [selectedPeriodical.type]
      : SEARCH_CONTENT_TYPE_BY_ID[nextContentType].types;
    const periodicalDatasetIds = nextDatasetId
      ? [nextDatasetId]
      : PERIODICAL_DATASETS.map((dataset) => dataset.id);
    // Vite forwards local searches so development ports do not depend on the
    // public search service's browser-origin allowlist.
    const request = platformRedesign
      ? axios.post(import.meta.env.DEV ? "/search-api/content/search" : CONTENT_SEARCH_API, {
          query: keyword,
          page: nextPage,
          size: pageSize,
          ...(nextContentType === "book"
            ? { sources: scopedBookDatasets.map((dataset) => dataset.label) }
            : nextContentType === "periodical"
              ? { datasetIds: periodicalDatasetIds }
              : {}),
          types: unifiedTypes,
          ...(nextSort ? { sort: nextSort } : {}),
          ...(nextStartDate && nextEndDate
            ? {
                startDate: formatSearchApiDate(nextStartDate),
                endDate: formatSearchApiDate(nextEndDate),
              }
            : {}),
        }, { signal: controller.signal })
      : axios.get(import.meta.env.DEV ? "/search-api/search" : ARCHIVE_SEARCH_API, {
          params: requestParams,
          signal: controller.signal,
        });

    void request
      .then((response) => {
        if (controller.signal.aborted || requestId !== requestIdRef.current) return;
        const data = response.data?.data;
        if (!data || !Array.isArray(data.results) || !Number.isFinite(data.total)) {
          throw new Error("Search API returned an invalid response");
        }
        const normalizedResults: SearchResult[] = data.results.map((result: SearchResult | UnifiedSearchResult) => (
          platformRedesign
            ? normalizeUnifiedResult(result)
            : {
                title: String(result.title ?? ""),
                content: String(result.content ?? ""),
                date: String(result.date ?? ""),
                page: Number((result as SearchResult).page) || 0,
                type: "newspaper",
                datasetId: "rmrb",
                itemId: `rmrb:${String(result.date ?? "")}`,
                source: "人民日报",
                itemTitle: "",
                chapterId: "",
                ellipsis: true,
              }
        ));
        setResults(nextContentType === "book"
          ? normalizedResults.filter((result) => findBookDataset(result, scopedBookDatasets))
          : normalizedResults);
        setResultsPage(nextPage);
        setTotal(Math.max(0, Number(data.total)));
      })
      .catch(() => {
        if (controller.signal.aborted || requestId !== requestIdRef.current) return;
        setResults(null);
        setTotal(0);
        setError("搜索失败，请检查网络后重试。");
      })
      .finally(() => {
        if (!controller.signal.aborted && requestId === requestIdRef.current) setLoading(false);
      });

    return () => controller.abort();
  }, [activeBookDatasetsKey, activeBookCatalogError, bookSearchReady, paramsKey, platformRedesign, retryToken]);

  useLayoutEffect(() => {
    if (loading || !scrollToResultsRef.current) return;
    scrollToResultsRef.current = false;
    // Wait for the new result layout. Removing the pagination during loading
    // can interrupt an in-flight smooth scroll in Firefox and WebKit.
    scrollContainerRef.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [loading, results]);

  function handleSearch() {
    const keyword = term.trim();
    if (!keyword) return;
    setPage(1);
    const query = buildSearchParams({
      keyword,
      page: 1,
      sort,
      startDate,
      endDate,
      ...(platformRedesign ? { contentType, datasetId } : {}),
    });
    if (query.toString() === paramsKey) setRetryToken((value) => value + 1);
    else setParams(query);
  }

  function handlePageChange(p: number) {
    scrollToResultsRef.current = true;
    setPage(p);
    setParams(buildSearchParams({
      keyword: term,
      page: p,
      sort,
      startDate,
      endDate,
      ...(platformRedesign ? { contentType, datasetId } : {}),
    }));
  }

  function handleSortChange(nextSort: string) {
    setSort(nextSort);
    setPage(1);
    setParams(buildSearchParams({
      keyword: term,
      page: 1,
      sort: nextSort,
      startDate,
      endDate,
      ...(platformRedesign ? { contentType, datasetId } : {}),
    }));
  }

  function handleDateRangeChange(nextRange: DateRangeValue) {
    setStartDate(nextRange.startDate);
    setEndDate(nextRange.endDate);
    setPage(1);
    setParams(buildSearchParams({
      keyword: term,
      page: 1,
      sort,
      ...nextRange,
      ...(platformRedesign ? { contentType, datasetId } : {}),
    }));
  }

  function handleContentTypeChange(nextContentType: SearchContentType) {
    if (nextContentType === contentType) return;
    setContentType(nextContentType);
    setDatasetId("");
    setPage(1);
    const nextContentTypeOption = SEARCH_CONTENT_TYPE_BY_ID[nextContentType];
    const supportsDate = nextContentTypeOption.supportsDate;
    const nextSort = nextContentTypeOption.supportsSort ? sort : "";
    setSort(nextSort);
    if (!supportsDate) {
      setStartDate("");
      setEndDate("");
    }
    if (beforeSearch) return;
    setParams(buildSearchParams({
      keyword: term,
      page: 1,
      sort: nextSort,
      startDate: supportsDate ? startDate : "",
      endDate: supportsDate ? endDate : "",
      contentType: nextContentType,
      datasetId: "",
    }));
  }

  function handleDatasetChange(nextDatasetId: string) {
    setDatasetId(nextDatasetId);
    setPage(1);
    setParams(buildSearchParams({
      keyword: term,
      page: 1,
      sort,
      startDate,
      endDate,
      contentType,
      datasetId: nextDatasetId,
    }));
  }

  const contentTypeOption = SEARCH_CONTENT_TYPE_BY_ID[contentType];
  const datasetOptions = contentType === "periodical" ? PERIODICAL_DATASETS : bookDatasets;
  const datasetSelectOptions = [
    { value: "", label: contentTypeOption.allLabel },
    ...datasetOptions.map((option) => ({ value: option.id, label: option.label })),
  ];
  const searchPlaceholder = platformRedesign ? `检索${contentTypeOption.label}正文` : "在JOJO看报上搜索";
  const catalogUnavailable = platformRedesign && contentType === "book" && bookCatalogError;
  const catalogFailure = catalogUnavailable && (
    <div role="alert" className="my-4 border border-red/40 px-4 py-5 text-center">
      <p className="mb-3 text-sm font-bold text-red">书籍目录加载失败，请检查网络后重试。</p>
      <Button onClick={() => setCatalogRetryToken((value) => value + 1)}>重新加载目录</Button>
    </div>
  );
  const searchScopeSelector = (
    <div className="search-scope">
      <h1 className="search-scope-title">全文检索</h1>
      <div className="search-scope-tabs" role="tablist" aria-label="检索对象">
        {SEARCH_CONTENT_TYPES.map((option) => {
          const selected = option.value === contentType;
          return (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={selected}
              className="search-scope-tab"
              onClick={() => handleContentTypeChange(option.value)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div
      ref={scrollContainerRef}
      data-search-scroll-container
      className={`h-full overflow-y-auto text-ink ${platformRedesign ? "app-search-page" : "bg-paper"}`}
    >
      {loading && !platformRedesign && <LoadingSpinner text="搜索中" fullscreen />}

      {/* Centered search */}
      {beforeSearch && (
        <div className={platformRedesign
          ? "search-entry"
          : "fixed inset-0 z-10 flex items-center justify-center"}
        >
          <div className={platformRedesign ? "search-entry-content" : "w-[90%] max-w-[640px]"}>
            {platformRedesign && searchScopeSelector}
            <div className={platformRedesign
              ? "app-search-box search-query"
              : "flex items-center gap-3 border-2 border-rule-dark bg-paper p-2 pl-4 transition-all focus-within:border-red focus-within:shadow-[4px_4px_0_rgba(139,26,26,.14)]"}
            >
              <input ref={inputRef} value={term} onChange={(e) => setTerm(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleSearch()} aria-label={platformRedesign ? "全文检索关键词" : undefined} placeholder={searchPlaceholder} className="h-10 min-w-0 flex-1 border-0 bg-transparent p-0 text-base focus:border-0 focus:shadow-none" />
              <Button onClick={handleSearch}>搜索</Button>
            </div>
            {catalogFailure}
            {platformRedesign && contentType === "book" && !bookCatalogReady && !bookCatalogError && (
              <p role="status" className="mt-4 text-sm text-muted">正在加载书籍目录…</p>
            )}
          </div>
        </div>
      )}

      {/* Results */}
      {!beforeSearch && (
        <div className={`max-w-[960px] mx-auto px-6 pb-12 ${platformRedesign ? "search-results" : ""}`}>
          {platformRedesign && searchScopeSelector}
          <div className={platformRedesign ? "app-search-box search-query" : "flex gap-3 py-5"}>
            <input ref={inputRef} value={term} onChange={(e) => setTerm(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleSearch()} aria-label={platformRedesign ? "全文检索关键词" : undefined} placeholder={searchPlaceholder} className="min-w-0 flex-1 h-10 text-sm" />
            <Button onClick={handleSearch}>搜索</Button>
          </div>

          {/* Filters */}
          <section className="mb-6 border-y border-rule bg-paper" aria-label="搜索筛选">
            <div className="flex flex-wrap items-center gap-3 px-4 py-3">
              {platformRedesign && (
                <Select
                  ariaLabel={contentTypeOption.selectLabel}
                  value={datasetId}
                  options={datasetSelectOptions}
                  onChange={handleDatasetChange}
                  prefix={contentTypeOption.sourceLabel}
                  searchable={contentType === "book"}
                  searchPlaceholder="搜索书名"
                  emptyText="未找到相关书籍"
                  className="w-full min-w-0 sm:w-[240px]"
                />
              )}
              {(!platformRedesign || contentTypeOption.supportsDate) && (
                <DateRangePicker
                  startDate={startDate}
                  endDate={endDate}
                  onChange={handleDateRangeChange}
                  disabledStartDate={disableUnavailableDate}
                  disabledEndDate={disableUnavailableDate}
                  editable
                  shortcutLabel="常用时期"
                  shortcuts={SEARCH_PERIODS.map((period) => ({
                    ...period,
                    endDate: period.endDate || latestAvailableDate,
                  }))}
                  widthClassName="w-full sm:w-[250px]"
                />
              )}
              {(!platformRedesign || contentTypeOption.supportsSort) && (
                <Select
                  ariaLabel="排序"
                  value={sort}
                  options={SORT_OPTIONS}
                  onChange={handleSortChange}
                  className="w-[150px]"
                />
              )}
            </div>
          </section>

          {catalogFailure}

          {platformRedesign && loading && !catalogUnavailable && (
            <p role="status" className="mb-4 border-l-2 border-red px-4 py-3 text-sm font-bold text-red">
              {results?.length ? "搜索中，暂时保留上次结果…" : "搜索中…"}
            </p>
          )}

          {error && (
            <div role="alert" className="border border-red/40 px-4 py-5 text-center">
              <p className="mb-3 text-sm font-bold text-red">{error}</p>
              <Button onClick={() => setRetryToken((value) => value + 1)}>重试</Button>
            </div>
          )}

          {results && !error && !catalogUnavailable && (
            <section aria-label="搜索结果" aria-busy={platformRedesign ? loading : undefined}>
              {results.length === 0 ? (
                (!platformRedesign || !loading) && <div className="py-20 text-center"><p className="text-muted font-bold">没有找到相关结果</p></div>
              ) : (
                <ol className="list-none m-0 p-0">
                  {results.map((r, i) => (
                    <li key={i} className="relative pl-14 py-5 border-t border-rule first:border-rule-dark">
                      <span className="absolute left-0 top-5 w-9 pb-1.5 border-b-2 border-red text-red text-[13px] font-bold tracking-wider">
                        {String(i + 1 + ((platformRedesign ? resultsPage : page) - 1) * pageSize).padStart(2, "0")}
                      </span>
                      <Link
                        to={withSearchLocation(unifiedResultPath(r, bookDatasets), {
                          query: params.get("keyword") || "",
                          title: r.type === "book" ? undefined : searchResultTitle(r.fullTitle ?? r.title),
                          quote: r.type === "book" ? searchResultQuote(r.preview || r.content, params.get("keyword") || "") : undefined,
                          page: r.type === "book" ? undefined : r.page,
                          returnTo: `${location.pathname}${location.search}`,
                        })}
                        target={openResultsInNewTab ? "_blank" : undefined}
                        rel={openResultsInNewTab ? "noreferrer" : undefined}
                      >
                        <h3 className="text-xl font-bold text-ink tracking-wide m-0 hover:text-red transition-colors">
                          {renderHighlighted(r.title, false, true)}
                        </h3>
                      </Link>
                      <div className="flex gap-1.5 py-2">
                        <Tag>{resultSourceLabel(r)}</Tag>
                        {r.type === "book" && r.source && r.source !== resultSourceLabel(r) && <Tag>{r.source}</Tag>}
                        {r.date && <Tag>{r.date}</Tag>}
                        {r.type !== "book" && r.page > 0 && <Tag>第{r.page}版</Tag>}
                      </div>
                      <div className={`text-sm leading-7 text-ink/80 ${r.ellipsis ? "line-clamp-3" : ""}`}>
                        {renderHighlighted(r.ellipsis && r.preview ? r.preview : r.content, true, false)}
                      </div>
                      {r.ellipsis && <button className="mt-1 text-xs font-bold text-red border-0 bg-transparent p-0 hover:text-red-dark cursor-pointer" onClick={() => { r.ellipsis = false; setResults([...results]); }}>显示全部</button>}
                    </li>
                  ))}
                </ol>
              )}
              {(!platformRedesign || !loading) && (
                <Pagination current={page} total={Math.ceil(total / pageSize)} onChange={handlePageChange} />
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
