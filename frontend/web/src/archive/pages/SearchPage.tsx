import { Fragment, useState, useEffect, useRef, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import axios from "axios";
import { Button, Tag, Pagination, LoadingSpinner, DateRangePicker, type DateRangeValue } from "@jojo/ui";
import { getLatestRmrbAvailableDate } from "../dateAvailability";
import { archiveIssuePath } from "../../routes";
import { rollout } from "../../rollout";

const SEARCH_API = "https://s1.jojokanbao.cn/search";

interface SearchResult {
  title: string;
  content: string;
  date: string;
  page: number;
  ellipsis: boolean;
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

function formatSearchApiDate(value: string): string {
  return value.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
}

function buildSearchParams({
  keyword,
  page,
  sort,
  startDate,
  endDate,
}: {
  keyword: string;
  page: number;
  sort: string;
  startDate: string;
  endDate: string;
}): URLSearchParams {
  const query = new URLSearchParams({ keyword: keyword.trim() });
  if (page > 1) query.set("page", String(page));
  if (sort) query.set("sort", sort);
  if (startDate && endDate) {
    query.set("startDate", startDate);
    query.set("endDate", endDate);
  }
  return query;
}

export function SearchPage({ platformRedesign = rollout.platformRedesign }: { platformRedesign?: boolean }) {
  const [params, setParams] = useSearchParams();
  const [term, setTerm] = useState(params.get("keyword") || "");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(parsePage(params.get("page")));
  const [sort, setSort] = useState(normalizeSort(params.get("sort")));
  const [startDate, setStartDate] = useState(params.get("startDate") || "");
  const [endDate, setEndDate] = useState(params.get("endDate") || "");
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
    const keyword = (params.get("keyword") || "").trim();
    const nextPage = parsePage(params.get("page"));
    const nextSort = normalizeSort(params.get("sort"));
    const nextStartDate = params.get("startDate") || "";
    const nextEndDate = params.get("endDate") || "";

    setTerm(keyword);
    setPage(nextPage);
    setSort(nextSort);
    setStartDate(nextStartDate);
    setEndDate(nextEndDate);

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

    void axios.get(SEARCH_API, { params: requestParams, signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted || requestId !== requestIdRef.current) return;
        const data = response.data?.data;
        if (!data || !Array.isArray(data.results) || !Number.isFinite(data.total)) {
          throw new Error("Search API returned an invalid response");
        }
        setResults(data.results.map((result: SearchResult) => ({
          title: String(result.title ?? ""),
          content: String(result.content ?? ""),
          date: String(result.date ?? ""),
          page: Number(result.page) || 0,
          ellipsis: true,
        })));
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
  }, [paramsKey, retryToken]);

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
    const query = buildSearchParams({ keyword, page: 1, sort, startDate, endDate });
    if (query.toString() === paramsKey) setRetryToken((value) => value + 1);
    else setParams(query);
  }

  function handlePageChange(p: number) {
    setPage(p);
    setParams(buildSearchParams({ keyword: term, page: p, sort, startDate, endDate }));
    scrollContainerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }

  function handleSortChange(nextSort: string) {
    setSort(nextSort);
    setSortDropdownOpen(false);
    setPage(1);
    setParams(buildSearchParams({ keyword: term, page: 1, sort: nextSort, startDate, endDate }));
  }

  function handleDateRangeChange(nextRange: DateRangeValue) {
    setStartDate(nextRange.startDate);
    setEndDate(nextRange.endDate);
    setPage(1);
    setParams(buildSearchParams({ keyword: term, page: 1, sort, ...nextRange }));
  }

  const selectedSortLabel = SORT_OPTIONS.find((option) => option.value === sort)?.label ?? "默认排序";

  return (
    <div ref={scrollContainerRef} data-search-scroll-container className="h-full overflow-y-auto bg-paper text-ink">
      {loading && <LoadingSpinner text="搜索中" fullscreen />}

      {/* Centered search */}
      {beforeSearch && (
        <div className={platformRedesign
          ? "flex min-h-[calc(100vh-64px)] items-center justify-center px-5"
          : "fixed inset-0 z-10 flex items-center justify-center"}
        >
          <div className="w-[90%] max-w-[640px]">
            <div className={platformRedesign
              ? "platform-search-box"
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
                      <a href={`${archiveIssuePath("rmrb", r.date.replace(/-/g, ""))}#page-${r.page}`} target="_blank" rel="noreferrer">
                        <h3 className="text-xl font-bold text-ink tracking-wide m-0 hover:text-red transition-colors">
                          {renderHighlighted(r.title, false, true)}
                        </h3>
                      </a>
                      <div className="flex gap-1.5 py-2">
                        <Tag>人民日报</Tag>
                        <Tag>{r.date}</Tag>
                        {r.page > 0 && <Tag>第{r.page}版</Tag>}
                      </div>
                      <div className={`text-sm leading-7 text-ink/80 ${r.ellipsis ? "line-clamp-3" : ""}`}>
                        {renderHighlighted(r.content, true, false)}
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
