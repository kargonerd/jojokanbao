import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Button } from "@jojo/ui";
import { BookCover } from "../library/BookCover";
import { bookCoverTone } from "../library/bookCatalog";
import { fuzzyBookTitleScore } from "../library/bookSearch";
import type { PeriodicalEntry } from "../library/catalog";
import { useRecentReadingStore, type RecentReadingItem } from "../library/recentReadingStore";
import { notebookApi } from "../rag/api";
import { readerReturnState, withReaderReturnTo } from "../rag/readerNavigation";
import type { RagNotebook } from "../rag/types";
import { dailyQuote } from "./dailyQuote";

function RecentCover({ item, periodicals }: { item: RecentReadingItem; periodicals: readonly PeriodicalEntry[] }) {
  if (item.kind === "book") {
    const path = item.href.split("?")[0]?.split("/").filter(Boolean) ?? [];
    const datasetId = item.datasetId ?? (path[0] === "book" && path[1] ? decodeURIComponent(path[1]) : undefined);
    const itemKey = item.itemKey ?? (path[0] === "book" && path[2] ? decodeURIComponent(path[2]) : undefined);
    if (datasetId) {
      return (
        <BookCover
          className="recent-cover"
          title={item.title}
          tone={bookCoverTone(`${datasetId}:${itemKey ?? ""}`)}
          datasetId={datasetId}
          itemKey={itemKey}
        />
      );
    }
    return <div className="recent-cover recent-cover-book"><b>{item.title}</b></div>;
  }
  const publicationId = item.publicationId ?? item.id.replace(/^periodical:/, "");
  const publication = periodicals.find((entry) => entry.id === publicationId);
  if (publication) {
    return (
      <div className="recent-cover recent-cover-image">
        <img src={publication.image} alt="" style={{ objectPosition: publication.imagePosition }} />
      </div>
    );
  }
  return (
    <div className="recent-cover recent-cover-paper">
      <b>{item.title}</b><small>{item.subtitle}</small><span /><span />
    </div>
  );
}

export function HomePage({ periodicals = [] }: { periodicals?: readonly PeriodicalEntry[] }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [query, setQuery] = useState("");
  const [books, setBooks] = useState<RagNotebook[]>([]);
  const [searchAttempted, setSearchAttempted] = useState(false);
  const storedRecentItems = useRecentReadingStore((state) => state.items);
  const includePeriodicals = periodicals.length > 0;
  const recentItems = storedRecentItems.filter((item) => includePeriodicals || item.kind === "book").slice(0, 4);
  const quote = useMemo(() => dailyQuote(), []);

  useEffect(() => {
    let active = true;
    void notebookApi.list().then((items) => {
      if (active) setBooks(items.filter((item) => item.type === "book" || item.type === "book-series"));
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  const matches = useMemo(() => {
    if (!query.trim()) return [];
    return books
      .map((book) => ({ book, score: fuzzyBookTitleScore(book.title || book.name || "", query) }))
      .filter((result) => Number.isFinite(result.score))
      .sort((left, right) => left.score - right.score)
      .slice(0, 6)
      .map((result) => result.book);
  }, [books, query]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (matches[0]) {
      navigate(withReaderReturnTo(
        `/library/${encodeURIComponent(matches[0].id)}`,
        `${location.pathname}${location.search}`,
      ));
      return;
    }
    setSearchAttempted(true);
  }

  return (
    <main className="app-home">
      <section className="home-search" aria-labelledby="home-search-title">
        <h1 id="home-search-title">今天读什么？</h1>
        <div className="home-book-search">
          <form className="app-search-box" onSubmit={submitSearch} role="search">
            <label className="sr-only" htmlFor="app-home-search">搜索书名</label>
            <input
              id="app-home-search"
              type="search"
              value={query}
              onChange={(event) => { setQuery(event.target.value); setSearchAttempted(false); }}
              placeholder="搜索书名"
              autoComplete="off"
            />
            <Button type="submit">搜索</Button>
          </form>
          {query.trim() && (
            <div className="home-book-results" role="listbox" aria-label="书名匹配结果">
              {matches.map((book) => (
                <button key={book.id} type="button" role="option" onClick={() => navigate(withReaderReturnTo(
                  `/library/${encodeURIComponent(book.id)}`,
                  `${location.pathname}${location.search}`,
                ))}>
                  <span>{book.title || book.name || "未命名书籍"}</span>
                </button>
              ))}
              {matches.length === 0 && <p>{searchAttempted ? "没有匹配的书籍" : "没有找到相近书名"}</p>}
            </div>
          )}
        </div>
        <blockquote className="daily-quote daily-quote-footnote" aria-label="每日语录">
          <p>{quote.text}</p>
          <cite>—— {quote.source}</cite>
        </blockquote>
      </section>

      <section className="home-reading" aria-labelledby="recent-reading-title">
        <div className="section-heading">
          <h2 id="recent-reading-title">继续阅读</h2>
          <Link to="/bookshelf">我的书架</Link>
        </div>
        {recentItems.length > 0 ? (
          <div className="recent-grid">
            {recentItems.map((item) => (
              <Link key={item.id} className="recent-card" to={item.href} state={readerReturnState(`${location.pathname}${location.search}`)}>
                <RecentCover item={item} periodicals={periodicals} />
                <div className="recent-copy">
                  <strong>{item.title}</strong>
                  <div className="recent-meta"><p>{item.subtitle}</p><span>{Math.round(item.progress)}%</span></div>
                  <progress max="100" value={item.progress}>{item.progress}%</progress>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="recent-empty">
            <span aria-hidden="true">阅</span>
            <div>
              <strong>还没有阅读记录</strong>
              <p>{includePeriodicals ? "从资料库打开一份报刊或书籍，下一次从这里接着读。" : "从资料库打开一本书，下一次从这里接着读。"}</p>
            </div>
            <Link to="/library">去资料库&nbsp;→</Link>
          </div>
        )}
      </section>

    </main>
  );
}
