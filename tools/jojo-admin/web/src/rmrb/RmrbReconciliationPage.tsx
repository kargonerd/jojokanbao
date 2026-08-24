import { useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { PageTopbar } from "../components/PageTopbar";
import {
  rmrbReconciliationApi,
  type RmrbReconciliationCandidate,
  type RmrbReconciliationCounts,
  type RmrbReconciliationItem,
  type RmrbReconciliationResolution,
} from "./reconciliationApi";

const PAGE_SIZE = 30;
const relationLabels: Record<string, string> = {
  suspected_title_typo: "同日同版 · 一字之差",
  same_date_other_page: "同日 · 其他版",
  adjacent_date: "相邻日期",
  adjacent_month_same_day: "相邻月份同日",
};
const decisionLabels: Record<RmrbReconciliationResolution, string> = {
  jsonl_correct: "JSONL 原记录正确",
  merge_candidate: "合并到人民数据候选",
  manual_metadata: "采用手工修正元数据",
  defer: "暂时搁置",
};

function highlightedDifference(value: string, reference: string): ReactNode {
  if (value === reference) return value;
  const source = [...value];
  const other = [...reference];
  let prefix = 0;
  while (prefix < source.length && prefix < other.length && source[prefix] === other[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < source.length - prefix &&
    suffix < other.length - prefix &&
    source[source.length - suffix - 1] === other[other.length - suffix - 1]
  ) {
    suffix += 1;
  }
  const before = source.slice(0, prefix).join("");
  const changed = source.slice(prefix, source.length - suffix).join("");
  const after = suffix ? source.slice(source.length - suffix).join("") : "";
  return <>{before}<mark>{changed || "∅"}</mark>{after}</>;
}

function CandidateCard({
  candidate,
  sourceDate,
  sourceTitle,
  disabled,
  onMerge,
}: {
  candidate: RmrbReconciliationCandidate;
  sourceDate: string;
  sourceTitle: string;
  disabled: boolean;
  onMerge: () => void;
}) {
  const dateDiffers = candidate.date !== sourceDate;
  return (
    <article className="rmrb-reconcile-candidate">
      <header>
        <div className="rmrb-reconcile-candidate-meta">
          {dateDiffers ? <span
            className="rmrb-reconcile-date-change"
            aria-label={`日期不同：JSONL ${sourceDate}，人民数据 ${candidate.date}`}
          >
            <span><small>JSONL</small><del>{sourceDate}</del></span>
            <b aria-hidden="true">→</b>
            <span><small>人民数据</small><mark>{candidate.date}</mark></span>
          </span> : <span>{candidate.date}</span>}
          <span>第 {candidate.page} 版 · #{candidate.ordinal}</span>
        </div>
        <a href={candidate.peopleDataHref} target="_blank" rel="noreferrer">打开人民数据</a>
      </header>
      <h3>{highlightedDifference(candidate.title, sourceTitle)}</h3>
      <p>{candidate.relations.map((relation) => relationLabels[relation] || relation).join(" · ")}</p>
      <button className="secondary-button" type="button" disabled={disabled} onClick={onMerge}>
        合并到这个候选
      </button>
    </article>
  );
}

export function RmrbReconciliationPage() {
  const [items, setItems] = useState<RmrbReconciliationItem[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<RmrbReconciliationCounts>();
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState(0);
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [signal, setSignal] = useState("all");
  const [status, setStatus] = useState("pending");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [resolvedDate, setResolvedDate] = useState("");
  const [resolvedPage, setResolvedPage] = useState(1);
  const [resolvedTitle, setResolvedTitle] = useState("");
  const [note, setNote] = useState("");

  const current = items[selected];
  const currentKey = current?.sourceKey || "";

  const resetEditor = useCallback((item?: RmrbReconciliationItem) => {
    setExpanded(false);
    setManualOpen(false);
    setResolvedDate(item?.date || "");
    setResolvedPage(item?.page || 1);
    setResolvedTitle(item?.title || "");
    setNote(item?.decision?.note || "");
  }, []);

  const load = useCallback(async (preferredIndex = 0) => {
    setBusy(true);
    setMessage("");
    try {
      const queue = await rmrbReconciliationApi.queue({
        offset,
        limit: PAGE_SIZE,
        query,
        signal,
        status,
      });
      setItems(queue.items);
      setTotal(queue.total);
      setCounts(queue.counts);
      const nextIndex = Math.min(preferredIndex, Math.max(queue.items.length - 1, 0));
      setSelected(nextIndex);
      resetEditor(queue.items[nextIndex]);
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }, [offset, query, resetEditor, signal, status]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { resetEditor(current); }, [currentKey, current, resetEditor]);

  function choose(index: number) {
    setSelected(index);
    resetEditor(items[index]);
    setMessage("");
  }

  function search(event: FormEvent) {
    event.preventDefault();
    setOffset(0);
    setQuery(searchInput);
  }

  function changeSignal(value: string) {
    setOffset(0);
    setSignal(value);
  }

  function changeStatus(value: string) {
    setOffset(0);
    setStatus(value);
  }

  async function decide(
    resolution: RmrbReconciliationResolution,
    candidateKey?: string,
  ) {
    if (!current || busy) return;
    if (resolution === "manual_metadata" && (!resolvedDate || resolvedPage < 1 || !resolvedTitle.trim())) {
      setMessage("手工修正需要填写日期、版次和标题。");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      await rmrbReconciliationApi.decide(current, {
        resolution,
        candidateKey,
        resolvedDate,
        resolvedPage,
        resolvedTitle: resolvedTitle.trim(),
        note: note.trim(),
      });
      setMessage(`${decisionLabels[resolution]}，已保存并进入下一条。`);
      await load(selected);
    } catch (error) {
      setMessage((error as Error).message);
      setBusy(false);
    }
  }

  async function undo() {
    if (!current || busy) return;
    setBusy(true);
    setMessage("");
    try {
      await rmrbReconciliationApi.undo(current);
      setMessage("决定已撤销，这条记录重新回到待审核。 ");
      await load(selected);
    } catch (error) {
      setMessage((error as Error).message);
      setBusy(false);
    }
  }

  const start = total ? offset + 1 : 0;
  const end = Math.min(offset + items.length, total);
  const progress = counts?.total ? Math.round(((counts.reviewed + counts.deferred) / counts.total) * 100) : 0;

  return (
    <>
      <PageTopbar
        eyebrow="RMRB / TITLE COLLATION"
        title="人民日报标题对勘"
        description="比较 JSONL 原记录与人民数据候选；决定只保存为本地审核状态，暂不发布。"
        aside={
          <div className="rmrb-reconcile-progress">
            <span>校对进度</span>
            <b>{counts ? `${(counts.reviewed + counts.deferred).toLocaleString()} / ${counts.total.toLocaleString()}` : "—"}</b>
            <i><em style={{ width: `${progress}%` }} /></i>
          </div>
        }
      />
      <main className="rmrb-reconcile-workspace">
        <aside className="rmrb-reconcile-queue">
          <form className="rmrb-reconcile-search" onSubmit={search}>
            <input
              aria-label="搜索日期或标题"
              placeholder="日期或标题"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
            />
            <button className="secondary-button" type="submit">搜索</button>
          </form>
          <div className="rmrb-reconcile-filters">
            <label>
              <span>状态</span>
              <select aria-label="审核状态" value={status} onChange={(event) => changeStatus(event.target.value)}>
                <option value="pending">待审核</option>
                <option value="reviewed">已确认</option>
                <option value="deferred">稍后处理</option>
                <option value="all">全部</option>
              </select>
            </label>
            <label>
              <span>疑点</span>
              <select aria-label="疑点类型" value={signal} onChange={(event) => changeSignal(event.target.value)}>
                <option value="all">全部类型</option>
                <option value="suspected_title_typo">疑似错字</option>
                <option value="same_date_other_page">同日其他版</option>
                <option value="adjacent_date">相邻日期</option>
                <option value="adjacent_month_same_day">相邻月份同日</option>
              </select>
            </label>
          </div>
          <p className="rmrb-reconcile-summary">
            待审核 {counts?.pending.toLocaleString() ?? "—"} · 已确认 {counts?.reviewed.toLocaleString() ?? "—"} · 搁置 {counts?.deferred.toLocaleString() ?? "—"}
          </p>
          <div className="rmrb-reconcile-list">
            {items.map((item, index) => (
              <button
                type="button"
                className={index === selected ? "active" : ""}
                key={item.sourceKey}
                onClick={() => choose(index)}
              >
                <span>{item.signalLabels[0]}</span>
                <b>{item.title}</b>
                <small>{item.date} · 第{item.page}版 · #{item.ordinal}</small>
              </button>
            ))}
          </div>
          <footer className="rmrb-reconcile-pager">
            <button className="secondary-button" disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>上一页</button>
            <span>{start.toLocaleString()}–{end.toLocaleString()} / {total.toLocaleString()}</span>
            <button className="secondary-button" disabled={busy || offset + items.length >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>下一页</button>
          </footer>
        </aside>

        <section className="rmrb-reconcile-desk">
          {current ? <>
            <header className="rmrb-reconcile-source-head">
              <div>
                <p className="eyebrow">JSONL 原记录 · {current.date} · 第 {current.page} 版 · #{current.ordinal}</p>
                <h2>{current.title}</h2>
              </div>
              <div className="rmrb-reconcile-tags">
                {current.signalLabels.map((label) => <span key={label}>{label}</span>)}
              </div>
            </header>

            <div className="rmrb-reconcile-evidence">
              <article className="rmrb-reconcile-source">
                <section className="rmrb-reconcile-source-title" aria-label="JSONL 目录标题">
                  <span>JSONL 目录标题</span>
                  <p>{current.title}</p>
                </section>
                <header>
                  <b>JSONL 正文</b>
                  <a href={current.sourcePageHref} target="_blank" rel="noreferrer">查看当天版面</a>
                </header>
                <pre className={expanded ? "expanded" : ""}>{current.content}</pre>
                <button className="text-button" type="button" onClick={() => setExpanded((value) => !value)}>
                  {expanded ? "收起正文" : "展开全文"}
                </button>
                <label>
                  <span>审核备注（可选）</span>
                  <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="例如：正文首句与目录题一致" />
                </label>
                {!current.decision && <div className="rmrb-reconcile-source-actions">
                  <button className="primary-button" disabled={busy} onClick={() => void decide("jsonl_correct")}>
                    JSONL 原记录正确
                  </button>
                  <button className="secondary-button" disabled={busy} onClick={() => void decide("defer")}>
                    稍后处理
                  </button>
                </div>}
              </article>

              <aside className="rmrb-reconcile-candidates">
                <header>
                  <span>人民数据候选</span>
                  <b>{current.candidates.length}</b>
                </header>
                {current.candidates.map((candidate) => (
                  <CandidateCard
                    key={candidate.candidateKey}
                    candidate={candidate}
                    sourceDate={current.date}
                    sourceTitle={current.title}
                    disabled={busy || Boolean(current.decision)}
                    onMerge={() => void decide("merge_candidate", candidate.candidateKey)}
                  />
                ))}
                {!current.candidates.length && <p className="rmrb-reconcile-empty">没有可合并的人民数据候选。</p>}
              </aside>
            </div>

            <section className={`rmrb-reconcile-manual ${manualOpen ? "open" : ""}`}>
              <button className="text-button" type="button" onClick={() => setManualOpen((value) => !value)}>
                {manualOpen ? "收起手工修正" : "候选都不对？手工修正日期、版次或标题"}
              </button>
              {manualOpen && <div>
                <label><span>日期</span><input type="date" value={resolvedDate} onChange={(event) => setResolvedDate(event.target.value)} /></label>
                <label><span>版次</span><input type="number" min={1} value={resolvedPage} onChange={(event) => setResolvedPage(Number(event.target.value))} /></label>
                <label className="title"><span>标题</span><input value={resolvedTitle} onChange={(event) => setResolvedTitle(event.target.value)} /></label>
                <button className="secondary-button" disabled={busy || Boolean(current.decision)} onClick={() => void decide("manual_metadata")}>按此修正</button>
              </div>}
            </section>

            {current.decision && <section className="rmrb-reconcile-decision">
              <div>
                <span>当前决定</span>
                <b>{decisionLabels[current.decision.resolution]}</b>
                {current.decision.candidate && <small>{current.decision.candidate.date} · 第{current.decision.candidate.page}版 · {current.decision.candidate.title}</small>}
              </div>
              <button className="secondary-button" disabled={busy} onClick={() => void undo()}>撤销并重新审核</button>
            </section>}
            {message && <p className="rmrb-reconcile-message" role="status">{message}</p>}
          </> : <p className="rmrb-reconcile-empty-state">{busy ? "正在读取审核队列…" : "当前筛选条件下没有记录。"}</p>}
        </section>
      </main>
    </>
  );
}
