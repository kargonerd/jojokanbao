import { useCallback, useEffect, useRef, useState } from "react";
import type { ClipboardEvent, FormEvent } from "react";
import { PageTopbar } from "../components/PageTopbar";
import {
  rmrbReviewApi,
  type RmrbDecisionImage,
  type RmrbReviewItem,
  type RmrbSourceStatus,
  type RmrbStats,
  type RmrbSyncStatus,
  type RmrbSyncTarget,
} from "./api";

const PAGE_SIZE = 40;
const MAX_PASTED_IMAGES = 10;
const MAX_PASTED_IMAGE_BYTES = 15 * 1024 * 1024;
const PASTE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const PEOPLE_DATA_IMAGE_PREFIX = "https://webvpn.zju.edu.cn/https/77726476706e69737468656265737421f4f6559d69206d5f6e048ce29b5a2e7b74a4/pic/";
type DraftImage = RmrbDecisionImage & { id: string };

function imageTypeFromSource(source: string): string | undefined {
  const path = source.split("?", 1)[0]?.toLowerCase() || "";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".gif")) return "image/gif";
  return undefined;
}

function imageNameFromSource(source: string): string {
  const parts = source.split("/");
  const encodedName = parts[parts.length - 1]?.split("?", 1)[0] || "clipboard-image";
  try {
    return decodeURIComponent(encodedName);
  } catch {
    return encodedName;
  }
}

function readImage(file: File): Promise<RmrbDecisionImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve({
      name: file.name || "clipboard-image",
      mediaType: file.type,
      dataUrl: String(reader.result || ""),
      size: file.size,
    }));
    reader.addEventListener("error", () => reject(new Error("无法读取剪贴板图片。")));
    reader.readAsDataURL(file);
  });
}

export function RmrbReviewPage() {
  const [items, setItems] = useState<RmrbReviewItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState(0);
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [content, setContent] = useState("");
  const [images, setImages] = useState<DraftImage[]>([]);
  const [reason, setReason] = useState("");
  const [stats, setStats] = useState<RmrbStats["counts"]>();
  const [sourceStatus, setSourceStatus] = useState<RmrbSourceStatus>();
  const [busy, setBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncElapsed, setSyncElapsed] = useState(0);
  const [syncStatus, setSyncStatus] = useState<RmrbSyncStatus>();
  const [message, setMessage] = useState("");
  const editorRef = useRef<HTMLDivElement>(null);

  const current = items[selected];
  const currentKey = current
    ? `${current.date}|${current.page}|${current.peopleDataOrdinal}`
    : "";

  useEffect(() => {
    if (!editorRef.current) return;
    editorRef.current.textContent = current?.decision?.content || "";
  }, [currentKey]);

  const load = useCallback(async (preferredIndex = 0) => {
    setBusy(true);
    setMessage("");
    try {
      const [queue, latestStats] = await Promise.all([
        rmrbReviewApi.queue(offset, PAGE_SIZE, query),
        rmrbReviewApi.stats(),
      ]);
      setItems(queue.items);
      setTotal(queue.total);
      setStats(latestStats.counts);
      setSelected(Math.min(preferredIndex, Math.max(queue.items.length - 1, 0)));
      setContent("");
      setImages([]);
      setReason("");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }, [offset, query]);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const refresh = async () => {
      try {
        const latest = await rmrbReviewApi.sourceStatus();
        if (stopped) return;
        setSourceStatus(latest);
        if (latest.status === "ready") {
          await load();
          return;
        }
        if (latest.status === "failed") {
          setMessage(latest.message);
          return;
        }
      } catch (error) {
        if (!stopped) setMessage((error as Error).message);
      }
      if (!stopped) timer = window.setTimeout(() => void refresh(), 1000);
    };
    void refresh();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [load]);
  useEffect(() => {
    void rmrbReviewApi.syncStatus().then(setSyncStatus).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!syncBusy) return;
    const started = Date.now();
    setSyncElapsed(0);
    const refresh = async () => {
      try {
        setSyncStatus(await rmrbReviewApi.syncStatus());
      } catch {
        // The publication request remains authoritative; retry on the next tick.
      }
    };
    void refresh();
    const progressTimer = window.setInterval(() => void refresh(), 750);
    const elapsedTimer = window.setInterval(() => {
      setSyncElapsed(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => {
      window.clearInterval(progressTimer);
      window.clearInterval(elapsedTimer);
    };
  }, [syncBusy]);

  function choose(index: number) {
    setSelected(index);
    setContent(items[index]?.decision?.content || "");
    setImages([]);
    setReason(items[index]?.decision?.reason || "");
    setMessage("");
  }

  function search(event: FormEvent) {
    event.preventDefault();
    setOffset(0);
    setQuery(searchInput);
  }

  function syncEditorState() {
    const editor = editorRef.current;
    if (!editor) return;
    setContent(editor.innerText || editor.textContent || "");
    const visibleImageIds = new Set(
      [...editor.querySelectorAll<HTMLImageElement>("img[data-rmrb-image-id]")]
        .map((image) => image.dataset.rmrbImageId || ""),
    );
    setImages((currentImages) => {
      const remaining = currentImages.filter((image) => visibleImageIds.has(image.id));
      return remaining.length === currentImages.length ? currentImages : remaining;
    });
  }

  function captureEmbeddedImages(): DraftImage[] {
    const editor = editorRef.current;
    if (!editor) return [];
    const captured: DraftImage[] = [];
    for (const element of editor.querySelectorAll<HTMLImageElement>("img:not([data-rmrb-image-id])")) {
      const source = element.currentSrc || element.src || element.getAttribute("src") || "";
      const dataMatch = source.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,/i);
      const mediaType = dataMatch?.[1]?.toLowerCase() || imageTypeFromSource(source);
      const isPeopleDataImage = source.startsWith(PEOPLE_DATA_IMAGE_PREFIX);
      if (!mediaType || (!dataMatch && !isPeopleDataImage)) continue;
      const id = `embedded-${Date.now()}-${captured.length}-${Math.random().toString(16).slice(2)}`;
      element.dataset.rmrbImageId = id;
      captured.push({
        id,
        name: imageNameFromSource(source),
        mediaType,
        ...(dataMatch ? { dataUrl: source } : { sourceUrl: source }),
      });
    }
    if (captured.length) {
      setImages((currentImages) => [...currentImages, ...captured].slice(0, MAX_PASTED_IMAGES));
      setMessage(`已识别 ${captured.length} 张网页图片，可直接暂存。`);
    }
    return captured;
  }

  function insertEditorImage(image: DraftImage) {
    const editor = editorRef.current;
    if (!editor || !image.dataUrl) return;
    const element = document.createElement("img");
    element.src = image.dataUrl;
    element.alt = image.name || "粘贴图片";
    element.dataset.rmrbImageId = image.id;
    const lineBreak = document.createElement("br");
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
    if (range && editor.contains(range.commonAncestorContainer)) {
      range.deleteContents();
      range.insertNode(lineBreak);
      range.insertNode(element);
      range.setStartAfter(lineBreak);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
    } else {
      editor.append(element, lineBreak);
    }
    editor.focus();
  }

  async function pasteImages(event: ClipboardEvent<HTMLDivElement>) {
    const files = [...event.clipboardData.items]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (!files.length) {
      window.setTimeout(() => captureEmbeddedImages(), 0);
      return;
    }
    event.preventDefault();
    const accepted = files.filter((file) => (
      PASTE_IMAGE_TYPES.has(file.type) && file.size <= MAX_PASTED_IMAGE_BYTES
    ));
    if (!accepted.length) {
      setMessage("图片需为 PNG、JPEG、WebP 或 GIF，且单张不超过 15 MB。");
      return;
    }
    const remaining = Math.max(0, MAX_PASTED_IMAGES - images.length);
    if (!remaining) {
      setMessage("一篇文章最多暂存 10 张图片。");
      return;
    }
    try {
      const loaded = await Promise.all(accepted.slice(0, remaining).map(readImage));
      const pasted = loaded.map((image, index) => ({
        ...image,
        id: `pasted-${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`,
      }));
      setImages((currentImages) => [...currentImages, ...pasted].slice(0, MAX_PASTED_IMAGES));
      pasted.forEach(insertEditorImage);
      setMessage(`已贴入 ${pasted.length} 张图片，可继续粘贴正文或直接暂存。`);
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  async function submit(decision: "accept" | "reject") {
    if (!current || busy) return;
    const capturedImages = decision === "accept" ? captureEmbeddedImages() : [];
    const submissionImages = [...images, ...capturedImages].slice(0, MAX_PASTED_IMAGES);
    if (decision === "accept" && !content.trim() && !submissionImages.length) {
      setMessage("Accept 需要先粘贴正文或图片。");
      return;
    }
    if (decision === "reject" && !reason.trim()) {
      setMessage("Reject 只用于确认无效的目录项，并且必须填写原因。");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      await rmrbReviewApi.decide(
        current,
        decision,
        content.trim(),
        reason.trim(),
        submissionImages.map(({ id: _id, ...image }) => image),
      );
      setMessage(decision === "accept" ? "已暂存并进入下一条。" : "已拒绝并进入下一条。");
      await load(selected);
    } catch (error) {
      setMessage((error as Error).message);
      setBusy(false);
    }
  }

  async function syncDecisions() {
    const targets: RmrbSyncTarget[] = ["huggingface", "b2"];
    if (syncBusy || !stats?.pendingPublication) return;
    setSyncBusy(true);
    setSyncElapsed(0);
    setMessage("");
    try {
      const result = await rmrbReviewApi.sync(targets);
      setMessage(`已发布 ${result.publishedChanges.toLocaleString()} 条修订，HF 与 B2 已同步。`);
      const [latestSyncStatus, latestStats] = await Promise.all([
        rmrbReviewApi.syncStatus(),
        rmrbReviewApi.stats(),
      ]);
      setSyncStatus(latestSyncStatus);
      setStats(latestStats.counts);
    } catch (error) {
      setMessage(`同步失败：${(error as Error).message}`);
    } finally {
      setSyncBusy(false);
    }
  }

  const start = total ? offset + 1 : 0;
  const end = Math.min(offset + items.length, total);
  const publishReady = Boolean(
    stats?.pendingPublication &&
    syncStatus?.configured.huggingface &&
    syncStatus?.configured.b2 &&
    !syncBusy,
  );
  const syncProgress = syncStatus?.progress;
  const publishButtonLabel = (() => {
    if (!syncBusy) return `发布 ${stats?.pendingPublication.toLocaleString() ?? "—"} 条修订`;
    if (syncProgress?.phase === "huggingface") return "正在提交 HF…";
    if (syncProgress?.phase === "b2") return "正在更新 B2…";
    return "正在准备发布…";
  })();
  const publishHint = syncBusy
    ? `${syncProgress?.message || "正在启动发布任务"} · ${syncElapsed} 秒`
    : syncProgress?.status === "succeeded"
      ? syncProgress.message
      : "HF Canonical + B2 Delivery";

  return (
    <>
      <PageTopbar
        eyebrow="RMRB / HUMAN REVIEW"
        title="人民日报缺失正文"
        description="待复核列表来自 HF Canonical；Accept 先暂存，发布后更新正式数据。"
        aside={
          <div className="rmrb-review-top-publish">
            <small aria-live="polite">{publishHint}</small>
            <button
              className="primary-button"
              type="button"
              disabled={!publishReady}
              onClick={() => void syncDecisions()}
            >
              {publishButtonLabel}
            </button>
            {syncBusy && (
              <div
                className="rmrb-review-publish-progress"
                role="progressbar"
                aria-label="发布进度"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={syncProgress?.percent ?? 3}
              >
                <i style={{ width: `${syncProgress?.percent ?? 3}%` }} />
              </div>
            )}
          </div>
        }
      />
      <main className="rmrb-review-workspace">
        <aside className="rmrb-review-queue">
          <form onSubmit={search} className="rmrb-review-search">
            <input
              aria-label="搜索日期或标题"
              placeholder="日期或标题"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
            />
            <button className="secondary-button" type="submit">搜索</button>
          </form>
          <p className="rmrb-review-summary">
            {sourceStatus?.status !== "ready"
              ? sourceStatus?.message || "正在连接 HF Canonical…"
              : <>待复核 {stats?.pending.toLocaleString() ?? "—"} · 待发布 {stats?.pendingPublication.toLocaleString() ?? "—"}</>}
          </p>
          <div className="rmrb-review-list">
            {items.map((item, index) => (
              <button
                type="button"
                className={index === selected ? "active" : ""}
                key={`${item.date}-${item.page}-${item.peopleDataOrdinal}`}
                onClick={() => choose(index)}
              >
                <b>{item.title}</b>
                <span>{item.date} · 第{item.page}版 · #{item.peopleDataOrdinal}</span>
              </button>
            ))}
          </div>
          <footer className="rmrb-review-pager">
            <button className="secondary-button" disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>上一页</button>
            <span>{start.toLocaleString()}–{end.toLocaleString()} / {total.toLocaleString()}</span>
            <button className="secondary-button" disabled={busy || offset + items.length >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>下一页</button>
          </footer>
        </aside>
        <section className="rmrb-review-editor">
          {current ? <>
            <p className="eyebrow">{current.date} · 第 {current.page} 版 · #{current.peopleDataOrdinal}</p>
            <h2>{current.title}</h2>
            <div className="rmrb-review-links">
              {current.peopleDataHref && <a href={current.peopleDataHref} target="_blank" rel="noreferrer">人民数据正文</a>}
            </div>
            <label>
              <span>正文与图片（不含标题）</span>
              <div className="rmrb-review-compose">
                <div
                  ref={editorRef}
                  className="rmrb-review-rich-editor"
                  role="textbox"
                  aria-label="正文"
                  aria-multiline="true"
                  contentEditable
                  suppressContentEditableWarning
                  data-placeholder="从人民数据复制后粘贴到这里；支持 Ctrl+V 直接贴文字和图片"
                  onInput={syncEditorState}
                  onPaste={(event) => void pasteImages(event)}
                />
                {images.length > 0 && <small>已粘贴 {images.length} 张图片</small>}
              </div>
            </label>
            <label>
              <span>复核说明（Reject 时必填）</span>
              <input aria-label="复核说明" value={reason} onChange={(event) => setReason(event.target.value)} />
            </label>
            <div className="rmrb-review-action-dock">
              <div className="rmrb-review-actions">
                <button className="primary-button" disabled={busy} onClick={() => void submit("accept")}>Accept · 暂存</button>
                <button className="secondary-button" disabled={busy} onClick={() => void submit("reject")}>Reject · 目录无效</button>
              </div>
            </div>
            {message && <p className="rmrb-review-message">{message}</p>}
          </> : <p>{busy ? "正在读取…" : "没有待处理记录。"}</p>}
        </section>
      </main>
    </>
  );
}
