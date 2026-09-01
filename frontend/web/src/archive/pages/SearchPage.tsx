import { Fragment, useState, useEffect, useRef, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import axios from "axios";
import {
  ARCHIVE_PUBLICATIONS,
  ARCHIVE_PUBLICATION_BY_ID,
  ARCHIVE_PUBLICATION_NAMES,
  ARCHIVE_SEARCH_API,
  CONTENT_SEARCH_API,
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

function unifiedResultPath(result: SearchResult, bookDatasets: readonly SearchDatasetOption[]): string {
  if (result.type === "book" && result.datasetId && result.itemId) {
    const canonicalDatasetId = bookDatasets.find((dataset) => dataset.label === result.source)?.id
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
  const [term, setTerm] = useState(params.get("keyword") || "");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(parsePage(params.get("page")));
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [beforeSearch, setBeforeSearch] = useState(!params.get("keyword"));
  const [retryToken, setRetryToken] = useState(0);
  const accountInitialized = useAccountSessionStore((state) => state.initialized);
  const userId = useAccountSessionStore((state) => state.userId);
  const signedIn = Boolean(userId);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef(0);
  const pageSize = 10;
  const paramsKey = params.toString();
  const requestedContentType = normalizeContentType(params.get("type"));
  const requestedDatasetId = normalizeDatasetId(params.get("dataset"), requestedContentType);
  const selectedBookSource = requestedContentType === "book" && requestedDatasetId
    ? bookDatasets.find((dataset) => dataset.id === requestedDatasetId)?.label || ""
    : "";
  const bookDatasetIds = bookDatasets.map((dataset) => dataset.id);
  const bookDatasetIdsKey = bookDatasetIds.join("\0");
  const activeBookDatasetIdsKey = requestedContentType === "book" ? bookDatasetIdsKey : "";
  const bookSearchReady = requestedContentType !== "book" || bookCatalogReady;
  const latestAvailableDate = getLatestRmrbAvailableDate();
  const disableUnavailableDate = (date: string) => date < EARLIEST_AVAILABLE_DATE || date > latestAvailableDate;

  useEffect(() => {
    if (!platformRedesign) return;
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
        if (active) setBookDatasets([]);
      })
      .finally(() => {
        if (active) setBookCatalogReady(true);
      });
    return () => { active = false; };
  }, [accountInitialized, platformRedesign, signedIn]);

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

    setTerm(keyword);
    setPage(nextPage);
    setSort(nextSort);
    setStartDate(nextStartDate);
    setEndDate(nextEndDate);
    setContentType(nextContentType);
    setDatasetId(nextDatasetId);

    if (!keyword) {
      requestIdRef.current += 1;
      setBeforeSearch(true);
      setResults(null);
      setTotal(0);
      setError(null);
      setLoading(false);
      inputRef.current?.focus();
      return;
    }

    if (platformRedesign && nextContentType === "book" && !bookSearchReady) {
      setBeforeSearch(false);
      setLoading(true);
      setError(null);
      return;
    }

    if (platformRedesign && nextContentType === "book" && (
      bookDatasetIds.length === 0 || (nextDatasetId && !bookDatasets.some((dataset) => dataset.id === nextDatasetId))
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
    const unifiedTypes = selectedPeriodical
      ? [selectedPeriodical.type]
      : SEARCH_CONTENT_TYPE_BY_ID[nextContentType].types;
    const periodicalDatasetIds = nextDatasetId
      ? [nextDatasetId]
      : PERIODICAL_DATASETS.map((dataset) => dataset.id);
    const request = platformRedesign
      ? axios.post(CONTENT_SEARCH_API, {
          query: keyword,
          page: nextPage,
          size: pageSize,
          ...(selectedBook
            ? { sources: [selectedBook.label] }
            : nextContentType === "book"
              ? { datasetIds: bookDatasetIds }
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
      : axios.get(ARCHIVE_SEARCH_API, { params: requestParams, signal: controller.signal });

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
        const allowedBookDatasetIds = new Set(bookDatasetIds);
        setResults(nextContentType === "book"
          ? normalizedResults.filter((result) => allowedBookDatasetIds.has(result.datasetId))
          : normalizedResults);
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
  }, [activeBookDatasetIdsKey, bookSearchReady, paramsKey, platformRedesign, retryToken, selectedBookSource]);

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
    setPage(p);
    setParams(buildSearchParams({
      keyword: term,
      page: p,
      sort,
      startDate,
      endDate,
      ...(platformRedesign ? { contentType, datasetId } : {}),
    }));
    scrollContainerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
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

  return (
    <div
      ref={scrollContainerRef}
      data-search-scroll-container
      className={`h-full overflow-y-auto text-ink ${platformRedesign ? "app-search-page" : "bg-paper"}`}
    >
      {loading && <LoadingSpinner text="搜索中" fullscreen />}

      {/* Centered search */}
      {beforeSearch && (
        <div className={platformRedesign
          ? "flex min-h-[calc(100vh-64px)] items-center justify-center px-5"
          : "fixed inset-0 z-10 flex items-center justify-center"}
        >
          <div className="w-[90%] max-w-[640px]">
            <div className={platformRedesign
              ? "app-search-box"
              : "flex items-center gap-3 border-2 border-rule-dark bg-paper p-2 pl-4 transition-all focus-within:border-red focus-within:shadow-[4px_4px_0_rgba(139,26,26,.14)]"}
            >
              <input ref={inputRef} value={term} onChange={(e) => setTerm(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleSearch()} placeholder="在JOJO看报上搜索" className="h-10 flex-1 border-0 bg-transparent p-0 text-base focus:border-0 focus:shadow-none" />
              <Button onClick={handleSearch}>搜索</Button>
            </div>
          </div>
        </div>
      )}

      {/* Results */}
      {!beforeSearch && (
        <div className="max-w-[960px] mx-auto px-6 pb-12">
          <div className="flex gap-3 py-5">
            <input ref={inputRef} value={term} onChange={(e) => setTerm(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleSearch()} placeholder="在JOJO看报上搜索" className="flex-1 h-10 text-sm" />
            <Button onClick={handleSearch}>搜索</Button>
          </div>

          {/* Filters */}
          <section className="mb-6 border-y border-rule bg-paper" aria-label="搜索筛选">
            {platformRedesign && (
              <div className="flex min-h-11 items-stretch border-b border-rule px-4">
                <span className="mr-5 flex shrink-0 items-center font-sans text-[10px] font-black tracking-[0.18em] text-muted">
                  搜索范围
                </span>
                <div className="flex items-stretch" role="tablist" aria-label="检索对象">
                  {SEARCH_CONTENT_TYPES.map((option) => {
                    const selected = option.value === contentType;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="tab"
                        aria-selected={selected}
                        className={`relative min-w-[84px] border-0 bg-transparent px-5 font-serif text-sm font-black tracking-[0.08em] transition-colors after:absolute after:inset-x-4 after:bottom-[-1px] after:h-0.5 after:origin-center after:transition-transform ${
                          selected
                            ? "text-red after:scale-x-100 after:bg-red"
                            : "text-ink after:scale-x-0 after:bg-red hover:text-red"
                        }`}
                        onClick={() => handleContentTypeChange(option.value)}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
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

          {error && (
            <div role="alert" className="border border-red/40 px-4 py-5 text-center">
              <p className="mb-3 text-sm font-bold text-red">{error}</p>
              <Button onClick={() => setRetryToken((value) => value + 1)}>重试</Button>
            </div>
          )}

          {results && !error && (
            <>
              {results.length === 0 ? (
                <div className="py-20 text-center"><p className="text-muted font-bold">没有找到相关结果</p></div>
              ) : (
                <ol className="list-none m-0 p-0">
                  {results.map((r, i) => (
                    <li key={i} className="relative pl-14 py-5 border-t border-rule first:border-rule-dark">
                      <span className="absolute left-0 top-5 w-9 pb-1.5 border-b-2 border-red text-red text-[13px] font-bold tracking-wider">
                        {String(i + 1 + (page - 1) * pageSize).padStart(2, "0")}
                      </span>
                      <Link
                        to={unifiedResultPath(r, bookDatasets)}
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
              <Pagination current={page} total={Math.ceil(total / pageSize)} onChange={handlePageChange} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
