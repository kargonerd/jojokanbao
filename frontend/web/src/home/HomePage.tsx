import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { Button } from "@jojo/ui";
import { useAccountSessionStore } from "../account/session";
import { BookCover } from "../library/BookCover";
import { bookCoverTone } from "../library/bookCatalog";
import { fuzzyBookTitleScore } from "../library/bookSearch";
import type { PeriodicalEntry } from "../library/catalog";
import { useRecentReadingStore, type RecentReadingItem } from "../library/recentReadingStore";
import { notebookApi } from "../rag/api";
import { isContentVisible } from "../rag/contentVisibility";
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

function recentReadingIdentity(item: RecentReadingItem): string {
  if (item.kind === "periodical") return `periodical:${item.publicationId ?? item.id}`;
  return `book:${item.title.normalize("NFKC").replaceAll(/\s+/gu, "").toLocaleLowerCase()}`;
}

function uniqueRecentReading(items: RecentReadingItem[]): RecentReadingItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const identity = recentReadingIdentity(item);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function recentBookDatasetId(item: RecentReadingItem): string | undefined {
  if (item.kind !== "book") return undefined;
  if (item.datasetId) return item.datasetId;
  const path = item.href.split("?")[0]?.split("/").filter(Boolean) ?? [];
  return path[0] === "book" && path[1] ? decodeURIComponent(path[1]) : undefined;
}

export function HomePage({ periodicals = [] }: { periodicals?: readonly PeriodicalEntry[] }) {
  const location = useLocation();
  const [query, setQuery] = useState("");
  const [books, setBooks] = useState<RagNotebook[]>([]);
  const [catalogStatus, setCatalogStatus] = useState<"loading" | "ready" | "error">("loading");
  const [catalogRequest, setCatalogRequest] = useState(0);
  const resultsRef = useRef<HTMLDivElement>(null);
  const accountInitialized = useAccountSessionStore((state) => state.initialized);
  const userId = useAccountSessionStore((state) => state.userId);
  const signedIn = Boolean(userId);
  const storedRecentItems = useRecentReadingStore((state) => state.items);
  const includePeriodicals = periodicals.length > 0;
  const recentBooksPending = !signedIn
    && (!accountInitialized || catalogStatus !== "ready")
    && storedRecentItems.some((item) => item.kind === "book");
  const visibleBooks = useMemo(
    () => books.filter((book) => isContentVisible(book.access, signedIn)),
    [books, signedIn],
  );
  const recentItems = uniqueRecentReading(
    storedRecentItems.filter((item) => includePeriodicals || item.kind === "book"),
  ).filter((item) => {
    if (item.kind !== "book" || signedIn) return true;
    if (!accountInitialized || catalogStatus !== "ready") return false;
    const datasetId = recentBookDatasetId(item);
    if (!datasetId) return true;
    const book = books.find((candidate) => candidate.id === datasetId);
    return !book || isContentVisible(book.access, false);
  }).slice(0, 4);
  const quote = useMemo(() => dailyQuote(), []);

  useEffect(() => {
    let active = true;
    setCatalogStatus("loading");
    void notebookApi.list().then((items) => {
      if (!active) return;
      setBooks(items.filter((item) => item.type === "book" || item.type === "book-series"));
      setCatalogStatus("ready");
    }).catch(() => {
      if (active) setCatalogStatus("error");
    });
    return () => { active = false; };
  }, [catalogRequest]);

  const matches = useMemo(() => {
    if (!query.trim()) return [];
    return visibleBooks
      .map((book) => ({ book, score: fuzzyBookTitleScore(book.title || book.name || "", query) }))
      .filter((result) => Number.isFinite(result.score))
      .sort((left, right) => left.score - right.score)
      .slice(0, 6)
      .map((result) => result.book);
  }, [query, visibleBooks]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (query.trim()) resultsRef.current?.focus();
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
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索书名"
              autoComplete="off"
              required
              aria-controls="home-book-results"
            />
            <Button type="submit">找书</Button>
          </form>
          {(query.trim() || catalogStatus === "error") && (
            <div id="home-book-results" ref={resultsRef} className="home-book-results" role="region" aria-label="书名匹配结果" tabIndex={-1}>
              {catalogStatus === "loading" ? <p role="status">正在载入书籍目录…</p> : catalogStatus === "error" ? <>
                <p role="alert">书籍目录暂时无法载入，请重试。</p>
                <button type="button" onClick={() => setCatalogRequest((request) => request + 1)}>重新载入</button>
              </> : <>
                {matches.map((book) => (
                  <Link key={book.id} to={withReaderReturnTo(
                    `/library/${encodeURIComponent(book.id)}`,
                    `${location.pathname}${location.search}`,
                  )}>
                    <span>{book.title || book.name || "未命名书籍"}</span>
                  </Link>
                ))}
                {matches.length === 0 && <p role="status">没有找到相近书名，请换个书名关键词。</p>}
              </>}
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
          <div className="section-heading-links">
            <Link to="/download">客户端</Link>
            <Link to="/bookshelf">我的书架</Link>
          </div>
        </div>
        {recentItems.length > 0 ? (
          <div className="recent-grid">
            {recentItems.map((item) => (
              <Link key={item.id} className={`recent-card${item.kind === "periodical" ? " recent-card-periodical" : ""}`} to={item.href} state={readerReturnState(`${location.pathname}${location.search}`)}>
                <RecentCover item={item} periodicals={periodicals} />
                <div className="recent-copy">
                  <strong>{item.title}</strong>
                  <div className="recent-meta">
                    <p>{item.kind === "book" && item.subtitle !== item.title ? `上次读到 · ${item.subtitle}` : item.subtitle}</p>
                    {item.kind === "book" ? <span>{Math.round(item.progress)}%</span> : null}
                  </div>
                  {item.kind === "book" ? <progress max="100" value={item.progress}>{item.progress}%</progress> : null}
                </div>
              </Link>
            ))}
          </div>
        ) : recentBooksPending ? (
          <div className="recent-empty" role="status">
            <span aria-hidden="true">阅</span>
            <div>
              <strong>{catalogStatus === "error" ? "暂时无法恢复阅读记录" : "正在恢复阅读记录…"}</strong>
              <p>{catalogStatus === "error" ? "书籍目录暂时无法载入，重试后继续阅读。" : "正在确认书籍目录，请稍候。"}</p>
            </div>
            {catalogStatus === "error" && <Button onClick={() => setCatalogRequest((request) => request + 1)}>重试恢复</Button>}
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
