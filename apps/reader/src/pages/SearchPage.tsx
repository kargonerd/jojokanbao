import { useState, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import axios from "axios";
import { Button, Tag, Pagination, LoadingSpinner, DatePicker } from "@jojo/ui";

const SEARCH_API = "https://s1.jojokanbao.cn/search";

interface SearchResult {
  title: string;
  content: string;
  date: string;
  page: number;
  ellipsis: boolean;
}

interface SearchFilterOverrides {
  sort?: string;
  startDate?: string;
  endDate?: string;
}

const SORT_OPTIONS = [
  { value: "", label: "默认排序" },
  { value: "match", label: "最佳匹配" },
  { value: "timeAsc", label: "时间升序" },
  { value: "timeDesc", label: "时间降序" },
] as const;

function highlight(str: string, replaceBreaks: boolean, strong: boolean): string {
  let out = replaceBreaks ? str.replace(/\n/g, "<br>") : str;
  const tag = strong ? "strong" : "span";
  out = out.replace(/@highlight@/g, `<${tag} class="text-red">`);
  out = out.replace(/@\/highlight@/g, `</${tag}>`);
  return out;
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const [term, setTerm] = useState(params.get("keyword") || "");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(Number(params.get("page")) || 1);
  const [sort, setSort] = useState(params.get("sort") || "");
  const [startDate, setStartDate] = useState(params.get("startDate") || "");
  const [endDate, setEndDate] = useState(params.get("endDate") || "");
  const [loading, setLoading] = useState(false);
  const [beforeSearch, setBeforeSearch] = useState(!params.get("keyword"));
  const [sortDropdownOpen, setSortDropdownOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const sortDropdownRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const pageSize = 10;

  useEffect(() => {
    if (params.get("keyword")) fetchResults();
    else inputRef.current?.focus();
  }, []);

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

  async function handleSearch() {
    if (!term.trim()) return;
    setPage(1);
    await fetchResults(1);
  }

  async function handlePageChange(p: number) {
    setPage(p);
    await fetchResults(p);
    scrollContainerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function fetchResults(p = page, overrides: SearchFilterOverrides = {}) {
    const nextSort = overrides.sort ?? sort;
    const nextStartDate = overrides.startDate ?? startDate;
    const nextEndDate = overrides.endDate ?? endDate;
    setLoading(true);
    const query: Record<string, string> = { keyword: term };
    if (p > 1) query.page = String(p);
    if (nextSort) query.sort = nextSort;
    if (nextStartDate && nextEndDate) {
      query.startDate = nextStartDate;
      query.endDate = nextEndDate;
    }
    setParams(query);

    try {
      const params: Record<string, any> = { keyword: term, page: p, size: pageSize };
      if (nextSort) params.sort = nextSort;
      if (nextStartDate && nextEndDate) {
        params.startDate = nextStartDate;
        params.endDate = nextEndDate;
      }
      const res = await axios.get(SEARCH_API, { params });
      const data = res.data.data;
      setResults(data.results.map((r: any) => ({ ...r, title: highlight(r.title, false, true), content: highlight(r.content, true, false), ellipsis: true })));
      setTotal(data.total);
      setBeforeSearch(false);
    } catch {
      setResults(null);
    } finally {
      setLoading(false);
    }
  }

  async function handleSortChange(nextSort: string) {
    setSort(nextSort);
    setSortDropdownOpen(false);
    setPage(1);
    await fetchResults(1, { sort: nextSort });
  }

  async function handleStartDateChange(nextStartDate: string) {
    setStartDate(nextStartDate);
    if (!nextStartDate || !endDate) return;
    setPage(1);
    await fetchResults(1, { startDate: nextStartDate });
  }

  async function handleEndDateChange(nextEndDate: string) {
    setEndDate(nextEndDate);
    if (!startDate || !nextEndDate) return;
    setPage(1);
    await fetchResults(1, { endDate: nextEndDate });
  }

  const selectedSortLabel = SORT_OPTIONS.find((option) => option.value === sort)?.label ?? "默认排序";

  return (
    <div ref={scrollContainerRef} data-search-scroll-container className="h-full overflow-y-auto bg-paper text-ink">
      {loading && <LoadingSpinner text="搜索中" fullscreen />}

      {/* Centered search */}
      {beforeSearch && (
        <div className="fixed inset-0 flex items-center justify-center z-10">
          <div className="w-[90%] max-w-[640px]">
            <div className="flex items-center gap-3 border-2 border-rule-dark bg-paper p-2 pl-4 transition-all focus-within:border-red focus-within:shadow-[4px_4px_0_rgba(139,26,26,.14)]">
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
          <div className="flex flex-wrap items-center gap-4 p-3.5 border border-rule mb-6">
            <label className="flex items-center gap-2 text-xs font-bold text-muted">
              从 <DatePicker value={startDate} onChange={handleStartDateChange} />
            </label>
            <label className="flex items-center gap-2 text-xs font-bold text-muted">
              至 <DatePicker value={endDate} onChange={handleEndDateChange} />
            </label>
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

          {results && (
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
                      <a href={`/rmrb/${r.date.replace(/-/g, "")}#page-${r.page}`} target="_blank" rel="noreferrer">
                        <h3 className="text-xl font-bold text-ink tracking-wide m-0 hover:text-red transition-colors" dangerouslySetInnerHTML={{ __html: r.title }} />
                      </a>
                      <div className="flex gap-1.5 py-2">
                        <Tag>人民日报</Tag>
                        <Tag>{r.date}</Tag>
                        {r.page > 0 && <Tag>第{r.page}版</Tag>}
                      </div>
                      <div className={`text-sm leading-7 text-ink/80 ${r.ellipsis ? "line-clamp-3" : ""}`} dangerouslySetInnerHTML={{ __html: r.content }} />
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
