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
import { Button, Tag, Pagination, LoadingSpinner, DateRangePicker, type DateRangeValue } from "@jojo/ui";
import { getLatestRmrbAvailableDate } from "../dateAvailability";
import { archiveIssuePath } from "../../routes";
import { rollout } from "../../rollout";
import { loadCatalog } from "../../rag/content";

type SearchContentType = "periodical" | "book";

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

const SEARCH_CONTENT_TYPES: ReadonlyArray<{ value: SearchContentType; label: string }> = [
  { value: "periodical", label: "报刊" },
  { value: "book", label: "书籍" },
];

const PERIODICAL_DATASETS: readonly SearchDatasetOption[] = ARCHIVE_PUBLICATIONS.map((publication) => ({
  id: publication.id,
  label: publication.title,
}));

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
  return ARCHIVE_PUBLICATION_NAMES.includes(datasetId as ArchivePublicationName) ? datasetId : "";
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
  if (sort) query.set("sort", sort);
  if (contentType === "book") query.set("type", "book");
  if (datasetId) query.set("dataset", datasetId);
  if (startDate && endDate) {
    query.set("startDate", startDate);
    query.set("endDate", endDate);
  }
  return query;
}

function unifiedResultPath(result: SearchResult): string {
  if (result.type === "book" && result.datasetId && result.itemId) {
    const chapter = result.chapterId ? `?chapter=${encodeURIComponent(result.chapterId)}` : "";
    return `/book/${encodeURIComponent(result.datasetId)}/${encodeURIComponent(result.itemId)}${chapter}`;
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [beforeSearch, setBeforeSearch] = useState(!params.get("keyword"));
  const [retryToken, setRetryToken] = useState(0);
  const [sortDropdownOpen, setSortDropdownOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const sortDropdownRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef(0);
  const pageSize = 10;
  const paramsKey = params.toString();
  const latestAvailableDate = getLatestRmrbAvailableDate();
  const disableUnavailableDate = (date: string) => date < EARLIEST_AVAILABLE_DATE || date > latestAvailableDate;

  useEffect(() => {
    if (!platformRedesign) return;
    let active = true;
    void loadCatalog()
      .then((catalog) => {
        if (!active) return;
        setBookDatasets(catalog.datasets
          .filter((dataset) => (
            (dataset.type === "book" || dataset.type === "book-series")
            && dataset.publicationStatus !== "draft"
          ))
          .map((dataset) => ({ id: dataset.datasetId, label: dataset.title }))
          .sort((left, right) => left.label.localeCompare(right.label, "zh-CN")));
      })
      .catch(() => {
        if (active) setBookDatasets([]);
      });
    return () => { active = false; };
  }, [platformRedesign]);

  useEffect(() => {
    const keyword = (params.get("keyword") || "").trim();
    const nextPage = parsePage(params.get("page"));
    const nextSort = normalizeSort(params.get("sort"));
    const nextContentType = platformRedesign ? normalizeContentType(params.get("type")) : "periodical";
    const nextDatasetId = platformRedesign
      ? normalizeDatasetId(params.get("dataset"), nextContentType)
      : "";
    const nextStartDate = nextContentType === "book" ? "" : params.get("startDate") || "";
    const nextEndDate = nextContentType === "book" ? "" : params.get("endDate") || "";

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
      ? ARCHIVE_PUBLICATION_BY_ID[nextDatasetId as ArchivePublicationName]
      : undefined;
    const unifiedTypes = nextContentType === "book"
      ? ["book"]
      : selectedPeriodical
        ? [selectedPeriodical.type]
        : ["newspaper", "magazine"];
    const request = platformRedesign
      ? axios.post(CONTENT_SEARCH_API, {
          query: keyword,
          page: nextPage,
          size: pageSize,
          ...(nextDatasetId ? { datasetIds: [nextDatasetId] } : {}),
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
        setResults(data.results.map((result: SearchResult | UnifiedSearchResult) => (
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
        )));
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
  }, [paramsKey, platformRedesign, retryToken]);

  useEffect(() => {
    if (!sortDropdownOpen) return;

    const handleOutsideClick = (event: MouseEvent) => {
      if (!sortDropdownRef.current?.contains(event.target as Node)) {
        setSortDropdownOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSortDropdownOpen(false);
    };

    document.addEventListener("mousedown", handleOutsideClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [sortDropdownOpen]);

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
    setSortDropdownOpen(false);
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
    if (nextContentType === "book") {
      setStartDate("");
      setEndDate("");
    }
    setParams(buildSearchParams({
      keyword: term,
      page: 1,
      sort,
      startDate: nextContentType === "book" ? "" : startDate,
      endDate: nextContentType === "book" ? "" : endDate,
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

  const selectedSortLabel = SORT_OPTIONS.find((option) => option.value === sort)?.label ?? "默认排序";
  const datasetOptions = contentType === "periodical" ? PERIODICAL_DATASETS : bookDatasets;

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
          <div className="mb-6 flex flex-wrap items-center gap-4 border border-rule p-3.5">
            {platformRedesign && (
              <div className="flex flex-wrap items-center gap-3" aria-label="搜索资料范围">
                <fieldset className="flex h-8 border border-rule-dark" aria-label="资料类型">
                  <legend className="sr-only">资料类型</legend>
                  {SEARCH_CONTENT_TYPES.map((option) => {
                    const selected = option.value === contentType;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        aria-pressed={selected}
                        className={`min-w-[72px] border-0 border-r border-rule-dark px-4 text-xs font-bold transition-colors last:border-r-0 ${
                          selected ? "bg-red text-paper" : "bg-paper text-ink hover:bg-red/10 hover:text-red"
                        }`}
                        onClick={() => handleContentTypeChange(option.value)}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </fieldset>
                <label className="flex h-8 items-center border border-rule-dark bg-paper">
                  <span className="border-r border-rule px-2.5 text-[11px] font-bold tracking-[0.16em] text-muted">范围</span>
                  <select
                    aria-label={contentType === "periodical" ? "具体报刊" : "具体书籍"}
                    value={datasetId}
                    onChange={(event) => handleDatasetChange(event.target.value)}
                    className="h-full min-w-[180px] border-0 bg-paper px-3 pr-8 text-xs text-ink shadow-none focus:border-0 focus:ring-0"
                  >
                    <option value="">{contentType === "periodical" ? "全部报刊" : "全部书籍"}</option>
                    {datasetOptions.map((option) => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            {(!platformRedesign || contentType === "periodical") && (
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
              />
            )}
            <div ref={sortDropdownRef} className="relative min-w-[120px]">
              <button
                type="button"
                className="flex h-8 w-full items-center justify-between gap-3 border border-rule-dark bg-paper px-2.5 text-left text-xs text-ink transition-colors hover:border-red hover:text-red"
                aria-haspopup="listbox"
                aria-expanded={sortDropdownOpen}
                onClick={() => setSortDropdownOpen((open) => !open)}
              >
                <span>{selectedSortLabel}</span>
                <svg
                  className={`h-3 w-3 shrink-0 transition-transform ${sortDropdownOpen ? "rotate-180" : ""}`}
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  aria-hidden="true"
                >
                  <path d="m4 6 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {sortDropdownOpen && (
                <div className="absolute left-0 top-full z-[90] mt-1 w-full border-2 border-red bg-paper shadow-[4px_4px_0_rgba(139,26,26,.14)]">
                  <div className="py-1" role="listbox" aria-label="排序">
                    {SORT_OPTIONS.map((option) => {
                      const selected = option.value === sort;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          className={`block h-9 w-full px-4 text-left text-xs transition-colors ${
                            selected ? "bg-red text-paper" : "text-ink hover:bg-red/10 hover:text-red"
                          }`}
                          onClick={() => handleSortChange(option.value)}
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>

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
                        to={unifiedResultPath(r)}
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
