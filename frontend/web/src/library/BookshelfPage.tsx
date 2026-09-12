import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { LoadingSpinner } from "@jojo/ui";
import { useAccountSessionStore } from "../account/session";
import { loadBookshelf, setBookshelf, type BookshelfEntry } from "../rag/readerData";
import { readerReturnState } from "../rag/readerNavigation";
import { BookCover } from "./BookCover";
import { bookCoverTone } from "./bookCatalog";
import { useRecentReadingStore } from "./recentReadingStore";
import { OfflineBookControl } from "../offline/OfflineBookControl";
import { startOfflineAccountSync, useOfflineBooksStore } from "../offline/books";
import { supportsOfflineBooks } from "../offline/platform";

function entryKey(entry: BookshelfEntry): string {
  return `${entry.datasetId}:${entry.itemId}`;
}

export function BookshelfPage() {
  const location = useLocation();
  const accountInitialized = useAccountSessionStore((state) => state.initialized);
  const userId = useAccountSessionStore((state) => state.userId);
  const recentItems = useRecentReadingStore((state) => state.items);
  const offlineEnabled = supportsOfflineBooks();
  const offlineRecords = useOfflineBooksStore((state) => state.books);
  const offlineLoading = useOfflineBooksStore((state) => state.loading);
  const offlineError = useOfflineBooksStore((state) => state.error);
  const [items, setItems] = useState<BookshelfEntry[]>([]);
  const [itemsOwner, setItemsOwner] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => { if (offlineEnabled) startOfflineAccountSync(); }, [offlineEnabled]);

  useEffect(() => {
    setItems([]);
    if (!accountInitialized || !userId) {
      setLoading(false);
      setError("");
      return;
    }

    let active = true;
    setLoading(true);
    setError("");
    void loadBookshelf()
      .then((entries) => {
        if (active) { setItems(entries); setItemsOwner(userId); }
      })
      .catch(() => {
        if (active) setError(offlineEnabled ? "云端书架暂时无法同步，已下载的书可以继续阅读。" : "书架暂时无法载入，请稍后重试。");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [accountInitialized, offlineEnabled, reloadKey, userId]);

  async function removeItem(entry: BookshelfEntry) {
    const key = entryKey(entry);
    setBusyKey(key);
    setError("");
    try {
      await setBookshelf({ ...entry, added: false });
      setItems((current) => current.filter((item) => entryKey(item) !== key));
    } catch {
      setError(`“${entry.title}”暂时无法移出书架，请稍后重试。`);
    } finally {
      setBusyKey("");
    }
  }

  // A downloaded book must survive a failed cloud request or an offline cold start.
  const cloudItems = userId && userId === itemsOwner ? items : [];
  const visibleItems = [...cloudItems];
  if (offlineEnabled) for (const record of offlineRecords) {
    if (!visibleItems.some((item) => item.datasetId === record.entry.datasetId && (item.itemId === record.item.itemId || item.itemId === record.item.itemKey))) {
      visibleItems.push({ datasetId: record.entry.datasetId, itemId: record.item.itemKey, title: record.item.title });
    }
  }
  const status = visibleItems.length > 0 ? "ready" : !accountInitialized || (offlineEnabled && offlineLoading)
    ? "checking"
    : !userId
      ? "signed-out"
      : loading
        ? "loading"
        : error && items.length === 0
          ? "error"
          : items.length === 0
            ? "empty"
            : "ready";

  return (
    <main className="app-bookshelf">
      <header className="bookshelf-heading">
        <div className="bookshelf-title"><h1>书架</h1></div>
        <div className="bookshelf-summary"><Link to="/library?type=book">去资料库选书</Link></div>
      </header>

      {error && visibleItems.length > 0 ? <p className="bookshelf-notice" role="status">{error}</p> : null}
      {offlineEnabled && offlineError ? <p className="bookshelf-notice" role="alert">{offlineError}</p> : null}

      {status === "checking" || status === "loading" ? (
        <div className="bookshelf-loading"><LoadingSpinner text={status === "checking" ? "正在恢复账号" : "正在整理书架"} /></div>
      ) : status === "signed-out" ? (
        <section className="bookshelf-empty" aria-label="登录后查看书架">
          <span aria-hidden="true">架</span>
          <div><h2>登录后查看你的书架</h2><p>收藏的书会同步到你的账号。</p></div>
          <Link to="/account?returnTo=%2Fbookshelf">登录&nbsp;→</Link>
        </section>
      ) : status === "error" ? (
        <section className="bookshelf-empty">
          <span aria-hidden="true">!</span>
          <div><h2>书架暂时无法载入</h2><p>请检查网络后再试一次。</p></div>
          <button type="button" onClick={() => setReloadKey((value) => value + 1)}>重新载入</button>
        </section>
      ) : status === "empty" ? (
        <section className="bookshelf-empty">
          <span aria-hidden="true">架</span>
          <div><h2>书架还是空的</h2><p>从资料库挑一本书，加入后会出现在这里。</p></div>
          <Link to="/library?type=book">去选书&nbsp;→</Link>
        </section>
      ) : (
        <section className="bookshelf-grid" aria-label="收藏的书">
          {visibleItems.map((item) => {
            const key = entryKey(item);
            const recent = recentItems.find((candidate) => candidate.kind === "book" && candidate.datasetId === item.datasetId && candidate.itemKey === item.itemId);
            return (
              <article key={key} className="bookshelf-card">
                <Link
                  to={`/book/${encodeURIComponent(item.datasetId)}/${encodeURIComponent(item.itemId)}`}
                  state={readerReturnState(`${location.pathname}${location.search}`)}
                >
                  <BookCover
                    className="bookshelf-cover"
                    title={item.title}
                    tone={bookCoverTone(key)}
                    datasetId={item.datasetId}
                    itemKey={item.itemId}
                  />
                  <strong>{item.title}</strong>
                  <small>{recent && recent.progress > 0 ? `继续阅读 · ${Math.round(recent.progress)}%` : "开始阅读"}</small>
                </Link>
                <div className="bookshelf-card-actions">
                {offlineEnabled && <OfflineBookControl datasetId={item.datasetId} itemKey={item.itemId} title={item.title} />}
                {cloudItems.some((entry) => entryKey(entry) === key) && <button
                  type="button"
                  disabled={busyKey === key}
                  onClick={() => void removeItem(item)}
                  aria-label={`移出书架：${item.title}`}
                >
                  {busyKey === key ? "正在移出…" : "移出"}
                </button>}
                </div>
              </article>
            );
          })}
        </section>
      )}
    </main>
  );
}
