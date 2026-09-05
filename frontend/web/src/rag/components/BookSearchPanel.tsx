import DOMPurify from "dompurify";
import { type FormEvent, useRef, useState } from "react";
import type { RagSearchHit } from "../types";

interface BookSearchPanelProps {
  bookTitle: string;
  embedded?: boolean;
  panelClass: string;
  onClose: () => void;
  onJump: (hit: RagSearchHit, matchText: string) => void;
  onSearch: (query: string) => Promise<RagSearchHit[]>;
}

function highlightedExcerpt(hit: RagSearchHit): string {
  const value = hit.highlights?.[0] || hit.text.slice(0, 260);
  return DOMPurify.sanitize(value, { ALLOWED_TAGS: ["mark"], ALLOWED_ATTR: [] });
}

function matchedText(hit: RagSearchHit, query: string): string {
  const html = hit.highlights?.[0];
  if (!html) return query;
  const document = new DOMParser().parseFromString(html, "text/html");
  return document.querySelector("mark")?.textContent?.trim() || query;
}

export function BookSearchPanel({ bookTitle, embedded = false, panelClass, onClose, onJump, onSearch }: BookSearchPanelProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RagSearchHit[]>([]);
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const value = query.trim();
    if (!value || searching) return;
    if (embedded) inputRef.current?.blur();
    setSearching(true);
    setError("");
    try {
      setResults(await onSearch(value));
      setSearched(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSearching(false);
    }
  }

  const Container = embedded ? "div" : "aside";
  return <Container aria-label={embedded ? undefined : "全书搜索"} className={embedded ? "flex min-h-0 flex-1 flex-col" : `fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l shadow-[-18px_0_50px_rgba(0,0,0,.12)] sm:w-[min(88vw,430px)] ${panelClass}`}>
    <header className={embedded ? "shrink-0 px-6 pb-3 pt-2" : "border-b border-rule px-6 py-5"}>
      {!embedded && <div className="flex items-start justify-between gap-5"><div><p className="m-0 font-sans text-[11px] tracking-[.18em] text-red">全书搜索</p><h2 className="mb-0 mt-2 text-lg leading-snug">{bookTitle}</h2></div><button type="button" onClick={onClose} className="border-0 bg-transparent text-2xl text-current cursor-pointer" aria-label="关闭全书搜索">×</button></div>}
      <form onSubmit={(event) => void submit(event)} className={`${embedded ? "" : "mt-5"} flex items-center gap-3 border-b border-rule focus-within:border-red`}>
        <span aria-hidden="true" className="font-sans text-sm text-muted">⌕</span>
        <input ref={inputRef} autoFocus enterKeyHint="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索正文" aria-label="搜索全书正文" className="book-toc-search min-w-0 flex-1 bg-transparent py-2 text-base text-current" />
        <button type="submit" disabled={!query.trim() || searching} className="min-h-11 min-w-11 shrink-0 border-0 bg-transparent p-0 font-sans text-xs font-bold text-red cursor-pointer disabled:opacity-30">搜索</button>
      </form>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
      {searching && <p className="font-sans text-xs text-muted">正在搜索本书……</p>}
      {error && <p role="alert" className="border-l-2 border-red pl-3 font-sans text-xs leading-6 text-red">{error}</p>}
      {!searching && searched && results.length === 0 && <p className="font-sans text-xs text-muted">本书没有找到“{query.trim()}”。</p>}
      <ol className="m-0 list-none p-0">{results.map((hit, index) => <li key={`${hit.fragmentObject || hit.targetId}-${index}`} className="border-b border-rule py-4 last:border-b-0"><button type="button" onClick={() => onJump(hit, matchedText(hit, query.trim()))} className="block w-full border-0 bg-transparent p-0 text-left text-current cursor-pointer"><strong className="block text-sm font-medium text-red">{hit.targetTitle || hit.title || "正文"}</strong><span className="book-search-excerpt mt-2 block text-xs leading-6 text-muted" dangerouslySetInnerHTML={{ __html: highlightedExcerpt(hit) }} /></button></li>)}</ol>
    </div>
  </Container>;
}
