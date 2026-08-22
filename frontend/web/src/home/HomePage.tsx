import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@jojo/ui";
import { useAccountSessionStore } from "../account/session";
import { useFeatureFlag, useFeatureFlagStore } from "../featureFlags";
import { BookCover } from "../library/BookCover";
import { bookCoverTone } from "../library/bookCatalog";
import { fuzzyBookTitleScore } from "../library/bookSearch";
import type { PeriodicalEntry } from "../library/catalog";
import { useRecentReadingStore, type RecentReadingItem } from "../library/recentReadingStore";
import { notebookApi } from "../rag/api";
import { loadBookshelf, type BookshelfEntry } from "../rag/readerData";
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
  const [query, setQuery] = useState("");
  const [books, setBooks] = useState<RagNotebook[]>([]);
  const [shelfItems, setShelfItems] = useState<BookshelfEntry[]>([]);
  const [shelfError, setShelfError] = useState("");
  const [searchAttempted, setSearchAttempted] = useState(false);
  const storedRecentItems = useRecentReadingStore((state) => state.items);
  const userId = useAccountSessionStore((state) => state.userId);
  const flagsInitialized = useFeatureFlagStore((state) => state.initialized);
  const bookshelfEnabled = useFeatureFlag("library.bookshelf");
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

  useEffect(() => {
    if (!userId || !bookshelfEnabled) {
      setShelfItems([]);
      setShelfError("");
      return;
    }
    let active = true;
    void loadBookshelf().then((items) => {
      if (!active) return;
      setShelfItems(items);
      setShelfError("");
    }).catch(() => {
      if (active) setShelfError("书架暂时无法载入");
    });
    return () => { active = false; };
  }, [bookshelfEnabled, userId]);

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
      navigate(`/library/${encodeURIComponent(matches[0].id)}`);
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
                <button key={book.id} type="button" role="option" onClick={() => navigate(`/library/${encodeURIComponent(book.id)}`)}>
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

      <section className="home-shelf" aria-labelledby="book-shelf-title">
        <div className="section-heading">
          <h2 id="book-shelf-title">我的书架</h2>
          <Link to="/library?type=book">去选书</Link>
        </div>
        {!userId ? (
          <div className="shelf-empty">
            <p>登录后查看你的书架</p>
            <Link to="/account?returnTo=/">登录&nbsp;→</Link>
          </div>
        ) : !flagsInitialized ? (
          <div className="shelf-empty"><p>正在确认书架权限</p></div>
        ) : !bookshelfEnabled ? (
          <div className="shelf-empty"><p>书架功能暂未向你的账号开放</p></div>
        ) : shelfError ? (
          <div className="shelf-empty"><p>{shelfError}</p></div>
        ) : shelfItems.length > 0 ? (
          <div className="shelf-grid">
            {shelfItems.map((book) => (
              <Link key={`${book.datasetId}:${book.itemId}`} className="shelf-book-card" to={`/book/${encodeURIComponent(book.datasetId)}/${encodeURIComponent(book.itemId)}`}>
                <BookCover title={book.title} tone={bookCoverTone(`${book.datasetId}:${book.itemId}`)} datasetId={book.datasetId} itemKey={book.itemId} />
                <strong>{book.title}</strong>
                <small>打开阅读</small>
              </Link>
            ))}
          </div>
        ) : (
          <div className="shelf-empty">
            <p>书架还是空的</p>
            <Link to="/library?type=book">去资料库选书&nbsp;→</Link>
          </div>
        )}
      </section>

      <section className="home-reading" aria-labelledby="recent-reading-title">
        <div className="section-heading">
          <h2 id="recent-reading-title">继续阅读</h2>
          <Link to="/library">资料库</Link>
        </div>
        {recentItems.length > 0 ? (
          <div className="recent-grid">
            {recentItems.map((item) => (
              <Link key={item.id} className="recent-card" to={item.href}>
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
