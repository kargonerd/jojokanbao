import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { LoadingSpinner } from "@jojo/ui";
import { useAccountSessionStore } from "../account/session";
import { useFeatureFlag, useFeatureFlagStore } from "../featureFlags";
import { notebookApi } from "../rag/api";
import { loadBookshelf, setBookshelf, type BookshelfEntry } from "../rag/readerData";
import type { RagNotebook, RagSource } from "../rag/types";
import { BookCover } from "./BookCover";
import { bookCoverTone, issueLabel } from "./bookCatalog";
import { fuzzyBookTitleScore } from "./bookSearch";
import type { PeriodicalEntry } from "./catalog";
import { useRecentReadingStore } from "./recentReadingStore";

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
  const [shelfBusyKey, setShelfBusyKey] = useState("");
  const [shelfError, setShelfError] = useState("");
  const [loading, setLoading] = useState(true);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [error, setError] = useState("");
  const remember = useRecentReadingStore((state) => state.remember);
  const accountInitialized = useAccountSessionStore((state) => state.initialized);
  const userId = useAccountSessionStore((state) => state.userId);
  const flagsInitialized = useFeatureFlagStore((state) => state.initialized);
  const bookshelfEnabled = useFeatureFlag("library.bookshelf");
  const includePeriodicals = periodicals.length > 0;
  const type = includePeriodicals ? normalizedType(searchParams.get("type")) : "book";
  const availableLibraryTypes = includePeriodicals
    ? libraryTypes
    : libraryTypes.filter((item) => item.id === "book");
  const openFirstSource = searchParams.get("open") === "first";

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
        if (!active) return;
        const publishedSources = items.filter((item) => item.published !== false);
        setSources(publishedSources);
        if (openFirstSource && publishedSources.length === 1) {
          const source = publishedSources[0]!;
          const itemKey = source.itemKey || source.id;
          const title = source.title || source.name || "未命名书籍";
          remember({
            id: `book:${datasetId}:${itemKey}`,
            kind: "book",
            datasetId,
            itemKey,
            title,
            subtitle: books.find((book) => book.id === datasetId)?.title || "书籍",
            href: `/book/${encodeURIComponent(datasetId)}/${encodeURIComponent(itemKey)}`,
            progress: 0,
          });
          navigate(`/book/${encodeURIComponent(datasetId)}/${encodeURIComponent(itemKey)}`, { replace: true });
        }
      })
      .catch(() => {
        if (active) setError("这套书的分卷目录暂时无法载入。");
      })
      .finally(() => {
        if (active) setSourceLoading(false);
      });
    return () => { active = false; };
  }, [datasetId, navigate, openFirstSource, remember]);

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

  function requireShelfAccess(): boolean {
    if (!userId) {
      const returnTo = `${location.pathname}${location.search}`;
      navigate(`/account?returnTo=${encodeURIComponent(returnTo)}`);
      return false;
    }
    if (!bookshelfEnabled) {
      setShelfError("书架功能暂未向你的账号开放。");
      return false;
    }
    return true;
  }

  async function updateShelf(entry: BookshelfEntry, added: boolean, busyKey: string) {
    setShelfBusyKey(busyKey);
    setShelfError("");
    try {
      await setBookshelf({ ...entry, added });
      setShelfItems((items) => added
        ? [entry, ...items.filter((item) => !(item.datasetId === entry.datasetId && item.itemId === entry.itemId))]
        : items.filter((item) => !(item.datasetId === entry.datasetId && item.itemId === entry.itemId)));
    } catch {
      setShelfError("书架操作失败，请稍后重试。");
    } finally {
      setShelfBusyKey("");
    }
  }

  async function toggleSingleBookShelf(book: RagNotebook) {
    if (!requireShelfAccess()) return;
    const existing = shelfItems.find((item) => item.datasetId === book.id);
    const busyKey = `book:${book.id}`;
    if (existing) {
      await updateShelf(existing, false, busyKey);
      return;
    }

    setShelfBusyKey(busyKey);
    setShelfError("");
    try {
      const bookSources = await notebookApi.getSources(book.id);
      const publishedSources = bookSources.filter((source) => source.published !== false);
      if (publishedSources.length !== 1) {
        setShelfError("分册目录已更新，请打开书目选择要加入的分册。");
        return;
      }
      const source = publishedSources[0]!;
      const entry = {
        datasetId: book.id,
        itemId: source.itemKey || source.id,
        title: source.title || source.name || book.title || book.name || "未命名书籍",
      };
      await setBookshelf({ ...entry, added: true });
      setShelfItems((items) => [entry, ...items]);
    } catch {
      setShelfError("书架操作失败，请稍后重试。");
    } finally {
      setShelfBusyKey("");
    }
  }

  async function toggleSourceShelf(source: RagSource) {
    if (!datasetId || !requireShelfAccess()) return;
    const entry = {
      datasetId,
      itemId: source.itemKey || source.id,
      title: source.title || source.name || "未命名书籍",
    };
    const onShelf = shelfItems.some((item) => item.datasetId === entry.datasetId && item.itemId === entry.itemId);
    await updateShelf(entry, !onShelf, `source:${entry.datasetId}:${entry.itemId}`);
  }

  const showPeriodicals = includePeriodicals && !datasetId && (type === "all" || type === "periodical");
  const showBooks = !datasetId && (type === "all" || type === "book");
  const titleMatches = (value: string) => !libraryQuery.trim() || Number.isFinite(fuzzyBookTitleScore(value, libraryQuery));
  const visiblePeriodicals = periodicals.filter((entry) => titleMatches(entry.title));
  const visibleBooks = books.filter((book) => titleMatches(book.title || book.name || ""));
  const visibleSources = sources.filter((source) => titleMatches(source.title || source.name || ""));
  return (
    <main className="app-library">
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
              <small>{(selectedBook?.sources_count ?? sources.length) > 1 ? `共 ${selectedBook?.sources_count ?? sources.length} 册` : "单册"}</small>
            </div>
          </div>
        )}

        <form className="app-search-box library-filter" role="search" onSubmit={(event) => event.preventDefault()}>
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

        {!datasetId && (
          <div className="cover-grid">
            {showPeriodicals && visiblePeriodicals.map((entry) => (
              <Link key={entry.id} className="cover-card" to={issuePath(entry)} onClick={() => rememberPeriodical(entry)}>
                <PaperCover entry={entry} /><strong>{entry.title}</strong><small>{entry.kind} · {entry.years}</small>
              </Link>
            ))}
            {!loading && showBooks && visibleBooks.map((book) => {
              const title = book.title || book.name || "未命名书籍";
              const sourceCount = book.sources_count ?? 0;
              const isSingle = sourceCount === 1;
              const onShelf = shelfItems.some((item) => item.datasetId === book.id);
              return (
                <article key={book.id} className="cover-card-shell">
                  <Link className="cover-card" to={`/library/${encodeURIComponent(book.id)}${isSingle ? "?open=first" : ""}`}>
                    <BookCover title={title} tone={bookCoverTone(book.id)} datasetId={book.id} />
                    <strong>{title}</strong>
                    <small className={isSingle ? "book-card-meta" : "book-card-meta is-series"}>
                      {isSingle ? "单册 · 直接阅读" : sourceCount > 1 ? `${sourceCount} 册 · 选择分册` : "查看分册"}
                    </small>
                  </Link>
                  {isSingle ? (
                    <button
                      type="button"
                      className={`shelf-toggle${onShelf ? " is-shelved" : ""}`}
                      aria-label={`${onShelf ? "移出书架" : userId ? bookshelfEnabled ? "加入书架" : "书架暂未开放" : "登录后加入书架"}：${title}`}
                      disabled={!accountInitialized || Boolean(userId && (!flagsInitialized || !bookshelfEnabled)) || shelfBusyKey === `book:${book.id}`}
                      onClick={() => void toggleSingleBookShelf(book)}
                    >
                      {!accountInitialized || shelfBusyKey === `book:${book.id}` ? "处理中…" : onShelf ? "已在书架" : userId ? !flagsInitialized ? "检查权限…" : bookshelfEnabled ? "+ 书架" : "暂未开放" : "登录后加入"}
                    </button>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}

        {datasetId && !sourceLoading && (
          <div className="cover-grid">
            {visibleSources.map((source) => {
              const itemKey = source.itemKey || source.id;
              const title = source.title || source.name || "未命名书籍";
              const onShelf = shelfItems.some((item) => item.datasetId === datasetId && item.itemId === itemKey);
              const busyKey = `source:${datasetId}:${itemKey}`;
              return (
                <article key={source.id} className="cover-card-shell">
                  <Link
                    className="cover-card"
                    to={`/book/${encodeURIComponent(datasetId)}/${encodeURIComponent(itemKey)}`}
                    onClick={() => rememberBook(source)}
                  >
                    <BookCover title={title} tone={bookCoverTone(`${datasetId}:${source.id}`)} datasetId={datasetId} itemKey={itemKey} />
                    <strong>{title}</strong><small>打开阅读</small>
                  </Link>
                  <button
                    type="button"
                    className={`shelf-toggle${onShelf ? " is-shelved" : ""}`}
                    aria-label={`${onShelf ? "移出书架" : userId ? bookshelfEnabled ? "加入书架" : "书架暂未开放" : "登录后加入书架"}：${title}`}
                    disabled={!accountInitialized || Boolean(userId && (!flagsInitialized || !bookshelfEnabled)) || shelfBusyKey === busyKey}
                    onClick={() => void toggleSourceShelf(source)}
                  >
                    {!accountInitialized || shelfBusyKey === busyKey ? "处理中…" : onShelf ? "已在书架" : userId ? !flagsInitialized ? "检查权限…" : bookshelfEnabled ? "+ 书架" : "暂未开放" : "登录后加入"}
                  </button>
                </article>
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
