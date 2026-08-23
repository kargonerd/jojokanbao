import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { PageTopbar } from "../components/PageTopbar";
import {
  rmrbReviewApi,
  type RmrbReviewItem,
  type RmrbStats,
  type RmrbSyncStatus,
  type RmrbSyncTarget,
} from "./api";

const PAGE_SIZE = 40;

export function RmrbReviewPage() {
  const [items, setItems] = useState<RmrbReviewItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState(0);
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [content, setContent] = useState("");
  const [reason, setReason] = useState("");
  const [stats, setStats] = useState<RmrbStats["counts"]>();
  const [busy, setBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncElapsed, setSyncElapsed] = useState(0);
  const [syncStatus, setSyncStatus] = useState<RmrbSyncStatus>();
  const [message, setMessage] = useState("");

  const current = items[selected];

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
      setReason("");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }, [offset, query]);

  useEffect(() => { void load(); }, [load]);
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
    setReason(items[index]?.decision?.reason || "");
    setMessage("");
  }

  function search(event: FormEvent) {
    event.preventDefault();
    setOffset(0);
    setQuery(searchInput);
  }

  async function submit(decision: "accept" | "reject") {
    if (!current || busy) return;
    if (decision === "accept" && !content.trim()) {
      setMessage("Accept 需要先粘贴正文。");
      return;
    }
    if (decision === "reject" && !reason.trim()) {
      setMessage("Reject 只用于确认无效的目录项，并且必须填写原因。");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      await rmrbReviewApi.decide(current, decision, content.trim(), reason.trim());
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
        description="Accept 先保存到本地；点击发布后增量更新正式数据。"
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
            待复核 {stats?.pending.toLocaleString() ?? "—"} · 待发布 {stats?.pendingPublication.toLocaleString() ?? "—"}
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
              <span>正文（不含标题）</span>
              <textarea
                aria-label="正文"
                value={content}
                onChange={(event) => setContent(event.target.value)}
                placeholder="从人民数据复制正文后粘贴到这里"
              />
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
