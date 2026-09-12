import { useRef, useState } from "react";
import { Check, Download, Xmark } from "iconoir-react";
import { formatOfflineBookBytes } from "@jojo/content";
import { offlineBooks, requestOfflinePersistence, useOfflineBooksStore } from "./books";

export function OfflineBookControl({ datasetId, itemKey, title }: { datasetId: string; itemKey: string; title: string }) {
  const books = useOfflineBooksStore((state) => state.books);
  const book = books.find((book) => book.entry.datasetId === datasetId && (book.item.itemKey === itemKey || book.item.itemId === itemKey));
  const [pending, setPending] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState("");
  const cancelled = useRef(false);
  async function download() {
    cancelled.current = false;
    setPending(true); setError("");
    try { await requestOfflinePersistence(); await offlineBooks.download({ datasetId, itemKey, title }); }
    catch (reason) { if (!cancelled.current) setError(reason instanceof Error ? reason.message : "下载失败，请重试"); }
    finally { setPending(false); }
  }
  async function remove() {
    if (!book) return;
    cancelled.current = true;
    setRemoving(true); setError("");
    try { await offlineBooks.remove(book); setExpanded(false); }
    catch { setError("未能删除下载，请重试"); }
    finally { setRemoving(false); }
  }
  const downloading = pending || book?.status === "downloading";
  const progress = book?.total ? Math.min(99, Math.floor(book.completed / book.total * 100)) : 0;
  const failure = error || (book?.status === "failed" ? book.error : "");
  return <div className="shelf-download">
    <div className="shelf-download-row">
      {book?.status === "ready" ? (
        <button type="button" className="shelf-download-ready" aria-label={`可离线：${title}`} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><Check aria-hidden="true" />可离线</button>
      ) : downloading ? (
        <>
          <span className="shelf-download-pending" role="status">{book ? `下载中 ${progress}%` : "准备下载…"}</span>
          {book && <button type="button" className="shelf-download-cancel" disabled={removing} aria-label={`取消下载：${title}`} onClick={() => void remove()}><Xmark aria-hidden="true" /></button>}
        </>
      ) : (
        <button type="button" disabled={removing} onClick={() => void download()} aria-label={`${book?.status === "failed" ? "重新下载" : "下载"}：${title}`}><Download aria-hidden="true" />{book?.status === "failed" ? "重试下载" : "下载"}</button>
      )}
    </div>
    {downloading && <div className="shelf-download-progress" role="progressbar" aria-label={`下载进度：${title}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={book ? progress : undefined}><span style={{ width: `${progress}%` }} /></div>}
    {expanded && book?.status === "ready" && <div className="shelf-download-detail"><span>{formatOfflineBookBytes(book.bytes)}</span><button type="button" disabled={removing} onClick={() => void remove()} aria-label={`删除下载：${title}`}>{removing ? "删除中…" : "删除下载"}</button></div>}
    {failure && !downloading && <p className="shelf-download-error" role="alert">{failure}</p>}
  </div>;
}
