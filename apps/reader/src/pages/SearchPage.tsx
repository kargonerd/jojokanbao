import { useState, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import axios from "axios";
import { Button, Tag, Pagination, LoadingSpinner } from "@jojo/ui";

const SEARCH_API = "https://search.jojokanbao.cn/api/search";

interface SearchResult {
  title: string;
  content: string;
  date: string;
  page: number;
  ellipsis: boolean;
}

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
  const inputRef = useRef<HTMLInputElement>(null);
  const pageSize = 10;

  useEffect(() => {
    if (params.get("keyword")) fetchResults();
    else inputRef.current?.focus();
  }, []);

  async function handleSearch() {
    if (!term.trim()) return;
    setPage(1);
    await fetchResults(1);
  }

  async function handlePageChange(p: number) {
    setPage(p);
    await fetchResults(p);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function fetchResults(p = page) {
    setLoading(true);
    const query: Record<string, string> = { keyword: term };
    if (p > 1) query.page = String(p);
    if (sort) query.sort = sort;
    if (startDate) query.startDate = startDate;
    if (endDate) query.endDate = endDate;
    setParams(query);

    try {
      const res = await axios.get(SEARCH_API, { params: { keyword: term, page: p, size: pageSize, sort: sort || undefined, startDate: startDate || undefined, endDate: endDate || undefined } });
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

  return (
    <div className="h-full overflow-y-auto bg-paper text-ink">
      {loading && <LoadingSpinner text="搜索中" fullscreen />}

      {/* Centered search */}
      {beforeSearch && (
        <div className="fixed inset-0 flex items-center justify-center z-10">
          <div className="w-[90%] max-w-[600px] p-6 border-4 border-red shadow-[inset_0_0_0_8px_var(--color-paper),inset_0_0_0_10px_var(--color-red)]">
            <div className="flex gap-3">
              <input ref={inputRef} value={term} onChange={(e) => setTerm(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleSearch()} placeholder="在JOJO看报上搜索" className="flex-1 h-10 text-sm" />
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
              从 <input type="date" value={startDate} onChange={(e) => { setStartDate(e.target.value); }} className="h-8 text-xs" />
            </label>
            <label className="flex items-center gap-2 text-xs font-bold text-muted">
              至 <input type="date" value={endDate} onChange={(e) => { setEndDate(e.target.value); handleSearch(); }} className="h-8 text-xs" />
            </label>
            <select value={sort} onChange={(e) => { setSort(e.target.value); handleSearch(); }} className="h-8 text-xs px-2">
              <option value="">默认排序</option>
              <option value="match">最佳匹配</option>
              <option value="timeAsc">时间升序</option>
              <option value="timeDesc">时间降序</option>
            </select>
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
