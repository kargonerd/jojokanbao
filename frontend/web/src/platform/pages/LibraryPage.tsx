import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { LoadingSpinner } from "@jojo/ui";
import { notebookApi } from "../../rag/api";
import { loadBookshelf, setBookshelf, type BookshelfEntry } from "../../rag/readerData";
import type { RagNotebook, RagSource } from "../../rag/types";
import type { PeriodicalEntry } from "../catalog";
import { bookCoverTone, issueLabel } from "../bookCatalog";
import { BookCover } from "../BookCover";
import { fuzzyBookTitleScore } from "../bookSearch";
import { usePlatformAccountStore } from "../accountSession";
import { useRecentReadingStore } from "../recentReadingStore";
import { useFeatureFlag, useFeatureFlagStore } from "../../featureFlags";

type LibraryType = "all" | "periodical" | "book";

const libraryTypes: Array<{ id: LibraryType; label: string }> = [
  { id: "all", label: "全部" },
  { id: "periodical", label: "报刊" },
  { id: "book", label: "书籍" },
];

function TypeIcon({ type }: { type: LibraryType }) {
  if (type === "periodical") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v16H5zM8 8h8M8 12h3M13 12h3M8 16h8" /></svg>;
  if (type === "book") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A3.5 3.5 0 0 1 7.5 2H11v17H7.5A3.5 3.5 0 0 0 4 22zM20 5.5A3.5 3.5 0 0 0 16.5 2H13v17h3.5A3.5 3.5 0 0 1 20 22z" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" /></svg>;
}

function PaperCover({ entry }: { entry: PeriodicalEntry }) {
  return (
    <div className="library-cover paper-cover">
      <img src={entry.image} alt={`${entry.title}历史刊面`} style={{ objectPosition: entry.imagePosition }} />
    </div>
  );
}

function normalizedType(value: string | null): LibraryType {
  return value === "periodical" || value === "book" ? value : "all";
}

export function LibraryPage({ periodicals = [] }: { periodicals?: readonly PeriodicalEntry[] }) {
  const { datasetId } = useParams<{ datasetId?: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [books, setBooks] = useState<RagNotebook[]>([]);
  const [sources, setSources] = useState<RagSource[]>([]);
  const [libraryQuery, setLibraryQuery] = useState("");
  const [shelfItems, setShelfItems] = useState<BookshelfEntry[]>([]);
  const [shelfBusyId, setShelfBusyId] = useState("");
  const [shelfError, setShelfError] = useState("");
  const [loading, setLoading] = useState(true);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [error, setError] = useState("");
  const remember = useRecentReadingStore((state) => state.remember);
  const accountInitialized = usePlatformAccountStore((state) => state.initialized);
  const userId = usePlatformAccountStore((state) => state.userId);
  const flagsInitialized = useFeatureFlagStore((state) => state.initialized);
  const bookshelfEnabled = useFeatureFlag("library.bookshelf");
  const includePeriodicals = periodicals.length > 0;
  const type = includePeriodicals ? normalizedType(searchParams.get("type")) : "book";
  const availableLibraryTypes = includePeriodicals
    ? libraryTypes
    : libraryTypes.filter((item) => item.id === "book");

  useEffect(() => {
    let active = true;
    setLoading(true);
    void notebookApi.list()
      .then((items) => {
        if (!active) return;
        setBooks(items.filter((item) => item.type === "book" || item.type === "book-series"));
        setError("");
      })
      .catch(() => {
        if (active) setError(includePeriodicals ? "书籍目录暂时无法载入，报刊仍可正常使用。" : "书籍目录暂时无法载入，请稍后重试。");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [includePeriodicals]);

  useEffect(() => {
    if (!userId || !bookshelfEnabled) {
      setShelfItems([]);
      setShelfError("");
      return;
    }
    let active = true;
    void loadBookshelf()
      .then((items) => {
        if (!active) return;
        setShelfItems(items);
        setShelfError("");
      })
      .catch(() => {
        if (active) setShelfError("书架暂时无法载入。");
      });
    return () => { active = false; };
  }, [bookshelfEnabled, userId]);

  const selectedBook = books.find((item) => item.id === datasetId);

  useEffect(() => {
    if (!datasetId) {
      setSources([]);
      setSourceLoading(false);
      return;
    }
    let active = true;
    setSourceLoading(true);
    void notebookApi.getSources(datasetId)
      .then((items) => {
        if (active) setSources(items.filter((item) => item.published !== false));
      })
      .catch(() => {
        if (active) setError("这套书的分卷目录暂时无法载入。");
      })
      .finally(() => {
        if (active) setSourceLoading(false);
      });
    return () => { active = false; };
  }, [datasetId]);

  function selectType(nextType: LibraryType) {
    setSearchParams(nextType === "all" ? {} : { type: nextType });
  }

  function issuePath(entry: PeriodicalEntry): string {
    return `/archive/${entry.id}/${entry.defaultIssueId}`;
  }

  function rememberPeriodical(entry: PeriodicalEntry) {
    const href = issuePath(entry);
    const id = href.split("/").at(-1) || entry.defaultIssueId;
    remember({ id: `periodical:${entry.id}`, kind: "periodical", publicationId: entry.id, title: entry.title, subtitle: issueLabel(id), href, progress: 0 });
  }

  function rememberBook(source: RagSource) {
    if (!datasetId) return;
    const itemKey = source.itemKey || source.id;
    remember({
      id: `book:${datasetId}:${itemKey}`,
      kind: "book",
      datasetId,
      itemKey,
      title: source.title || source.name || selectedBook?.title || "未命名书籍",
      subtitle: selectedBook?.title || "书籍",
      href: `/book/${encodeURIComponent(datasetId)}/${encodeURIComponent(itemKey)}`,
      progress: 0,
    });
  }

  async function toggleBookShelf(book: RagNotebook) {
    const title = book.title || book.name || "未命名书籍";
    if (!userId) {
      const returnTo = `${location.pathname}${location.search}`;
      navigate(`/account?returnTo=${encodeURIComponent(returnTo)}`);
      return;
    }
    if (!bookshelfEnabled) {
      setShelfError("书架功能暂未向你的账号开放。");
      return;
    }

    const existingEntries = shelfItems.filter((item) => item.datasetId === book.id);
    setShelfBusyId(book.id);
    setShelfError("");
    try {
      if (existingEntries.length > 0) {
        await Promise.all(existingEntries.map((entry) => setBookshelf({
          datasetId: entry.datasetId,
          itemId: entry.itemId,
          title: entry.title,
          added: false,
        })));
        setShelfItems((items) => items.filter((item) => item.datasetId !== book.id));
        return;
      }

      const bookSources = await notebookApi.getSources(book.id);
      const firstSource = bookSources.find((source) => source.published !== false);
      if (!firstSource) {
        setShelfError("这本书暂时没有可加入书架的分卷。");
        return;
      }
      const itemId = firstSource.itemKey || firstSource.id;
      const shelfTitle = firstSource.title || firstSource.name || title;
      await setBookshelf({ datasetId: book.id, itemId, title: shelfTitle, added: true });
      setShelfItems((items) => [{ datasetId: book.id, itemId, title: shelfTitle }, ...items]);
    } catch {
      setShelfError("书架操作失败，请稍后重试。");
    } finally {
      setShelfBusyId("");
    }
  }

  const showPeriodicals = includePeriodicals && !datasetId && (type === "all" || type === "periodical");
  const showBooks = !datasetId && (type === "all" || type === "book");
  const titleMatches = (value: string) => !libraryQuery.trim() || Number.isFinite(fuzzyBookTitleScore(value, libraryQuery));
  const visiblePeriodicals = periodicals.filter((entry) => titleMatches(entry.title));
  const visibleBooks = books.filter((book) => titleMatches(book.title || book.name || ""));
  const visibleSources = sources.filter((source) => titleMatches(source.title || source.name || ""));
  return (
    <main className="platform-library">
      <aside className="library-types" aria-label="资料类型">
        {availableLibraryTypes.map((item) => (
          <button
            key={item.id}
            type="button"
            disabled={Boolean(datasetId)}
            className={!datasetId && item.id === type ? "is-selected" : undefined}
            onClick={() => selectType(item.id)}
          >
            <TypeIcon type={item.id} /><span>{item.label}</span>
          </button>
        ))}
      </aside>

      <section className="library-main" aria-label={selectedBook?.title || "馆藏列表"}>
        {datasetId && (
          <div className="library-heading library-heading-compact">
            <div>
              <Link className="library-back" to="/library?type=book">← 返回书籍</Link>
              <h1>{selectedBook?.title || "书籍分卷"}</h1>
            </div>
          </div>
        )}

        <form className="platform-search-box library-filter" role="search" onSubmit={(event) => event.preventDefault()}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" /></svg>
          <label className="sr-only" htmlFor="library-filter-input">{datasetId ? "搜索本书分卷" : "搜索馆藏"}</label>
          <input
            id="library-filter-input"
            type="search"
            value={libraryQuery}
            onChange={(event) => setLibraryQuery(event.target.value)}
            placeholder={datasetId ? "搜索本书分卷" : includePeriodicals ? "搜索报刊或书名" : "搜索书名"}
          />
          {libraryQuery && <button type="button" onClick={() => setLibraryQuery("")} aria-label="清空馆藏搜索">清除</button>}
        </form>

        {(error || shelfError) && <p className="library-notice" role="status">{error || shelfError}</p>}
        {(loading || sourceLoading) && <div className="library-loading"><LoadingSpinner text="正在整理馆藏" /></div>}

        {!datasetId && !loading && (
          <div className="cover-grid">
            {showPeriodicals && visiblePeriodicals.map((entry) => (
              <Link key={entry.id} className="cover-card" to={issuePath(entry)} onClick={() => rememberPeriodical(entry)}>
                <PaperCover entry={entry} /><strong>{entry.title}</strong><small>{entry.kind} · {entry.years}</small>
              </Link>
            ))}
            {showBooks && visibleBooks.map((book) => {
              const title = book.title || book.name || "未命名书籍";
              const onShelf = shelfItems.some((item) => item.datasetId === book.id);
              return (
                <article key={book.id} className="cover-card-shell">
                  <Link className="cover-card" to={`/library/${encodeURIComponent(book.id)}`}>
                    <BookCover title={title} tone={bookCoverTone(book.id)} datasetId={book.id} />
                    <strong>{title}</strong>
                  </Link>
                  <button
                    type="button"
                    className={`shelf-toggle${onShelf ? " is-shelved" : ""}`}
                    aria-label={`${onShelf ? "移出书架" : userId ? bookshelfEnabled ? "加入书架" : "书架暂未开放" : "登录后加入书架"}：${title}`}
                    disabled={!accountInitialized || Boolean(userId && (!flagsInitialized || !bookshelfEnabled)) || shelfBusyId === book.id}
                    onClick={() => void toggleBookShelf(book)}
                  >
                    {!accountInitialized || shelfBusyId === book.id ? "处理中…" : onShelf ? "已在书架" : userId ? !flagsInitialized ? "检查权限…" : bookshelfEnabled ? "+ 书架" : "暂未开放" : "登录后加入"}
                  </button>
                </article>
              );
            })}
          </div>
        )}

        {datasetId && !sourceLoading && (
          <div className="cover-grid">
            {visibleSources.map((source, index) => {
              const itemKey = source.itemKey || source.id;
              const title = source.title || source.name || "未命名书籍";
              return (
                <Link
                  key={source.id}
                  className="cover-card"
                  to={`/book/${encodeURIComponent(datasetId)}/${encodeURIComponent(itemKey)}`}
                  onClick={() => rememberBook(source)}
                >
                  <BookCover title={title} tone={bookCoverTone(`${datasetId}:${source.id}`)} datasetId={datasetId} itemKey={itemKey} />
                  <strong>{title}</strong><small>打开阅读</small>
                </Link>
              );
            })}
          </div>
        )}

        {!loading && !sourceLoading && ((datasetId && visibleSources.length === 0) || (!datasetId && (!showPeriodicals || visiblePeriodicals.length === 0) && (!showBooks || visibleBooks.length === 0))) && (
          <p className="library-empty">没有找到匹配的资料。</p>
        )}
      </section>
    </main>
  );
}
