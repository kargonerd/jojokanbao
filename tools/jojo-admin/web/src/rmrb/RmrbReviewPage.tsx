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
  const [syncStatus, setSyncStatus] = useState<RmrbSyncStatus>();
  const [syncTargets, setSyncTargets] = useState<Record<RmrbSyncTarget, boolean>>({
    huggingface: false,
    b2: false,
  });
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
    const targets = (Object.entries(syncTargets) as [RmrbSyncTarget, boolean][])
      .filter(([, selected]) => selected)
      .map(([target]) => target);
    if (!targets.length || syncBusy) {
      setMessage("请先选择 Hugging Face 或 B2。");
      return;
    }
    setSyncBusy(true);
    setMessage("");
    try {
      const result = await rmrbReviewApi.sync(targets);
      const labels = targets.map((target) => target === "huggingface" ? "Hugging Face" : "B2");
      setMessage(`已向 ${labels.join("、")} 发布 ${result.publishedChanges.toLocaleString()} 条新修订。`);
      setSyncStatus(await rmrbReviewApi.syncStatus());
    } catch (error) {
      setMessage(`同步失败：${(error as Error).message}`);
    } finally {
      setSyncBusy(false);
    }
  }

  const start = total ? offset + 1 : 0;
  const end = Math.min(offset + items.length, total);

  return (
    <>
      <PageTopbar
        eyebrow="RMRB / HUMAN REVIEW"
        title="人民日报缺失正文"
        description="Accept 先保存到本地；点击发布后增量更新正式数据。"
        aside={<span className="local-badge"><i />按日期升序</span>}
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
            待处理 {stats?.pending.toLocaleString() ?? "—"} · 已处理 {stats ? (stats.accept + stats.reject).toLocaleString() : "—"}
          </p>
          <div className="rmrb-review-sync">
            <b>发布修订数据</b>
            <div>
              <label>
                <input
                  type="checkbox"
                  checked={syncTargets.huggingface}
                  disabled={!syncStatus?.configured.huggingface || syncBusy}
                  onChange={(event) => setSyncTargets((value) => ({ ...value, huggingface: event.target.checked }))}
                /> HF
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={syncTargets.b2}
                  disabled={!syncStatus?.configured.b2 || syncBusy}
                  onChange={(event) => setSyncTargets((value) => ({ ...value, b2: event.target.checked }))}
                /> B2
              </label>
              <button
                className="secondary-button"
                type="button"
                disabled={syncBusy || !Object.values(syncTargets).some(Boolean)}
                onClick={() => void syncDecisions()}
              >{syncBusy ? "发布中…" : "立即发布"}</button>
            </div>
            <small>
              HF 更新规范数据 · B2 更新前端 Delivery
              {syncStatus?.state.targets && Object.keys(syncStatus.state.targets).length > 0 ? " · 已发布过" : " · 尚未发布"}
            </small>
          </div>
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
              <span>复核说明（可选）</span>
              <input aria-label="复核说明" value={reason} onChange={(event) => setReason(event.target.value)} />
            </label>
            <div className="rmrb-review-actions">
              <button className="primary-button" disabled={busy} onClick={() => void submit("accept")}>Accept · 暂存</button>
              <button className="secondary-button" disabled={busy} onClick={() => void submit("reject")}>Reject · 暂存</button>
            </div>
            {message && <p className="rmrb-review-message">{message}</p>}
          </> : <p>{busy ? "正在读取…" : "没有待处理记录。"}</p>}
        </section>
      </main>
    </>
  );
}
