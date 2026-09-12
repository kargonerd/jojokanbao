import { useCallback, useEffect, useRef, useState } from "react";
import { PageTopbar } from "../components/PageTopbar";
import { correctionsApi, type CorrectionFilter, type CorrectionItem, type CorrectionStatus } from "./api";

const statuses: Array<{ value: CorrectionFilter; label: string }> = [
  { value: "pending", label: "待处理" }, { value: "in_progress", label: "核查中" },
  { value: "resolved", label: "已修正" }, { value: "dismissed", label: "已答复" }, { value: "all", label: "全部" },
];
const categories: Record<string, string> = { typo: "文字错误", missing_page: "缺页 / 缺内容", wrong_page: "错页 / 顺序错误", layout: "排版问题", other: "其他问题" };

export function CorrectionsPage() {
  const [filter, setFilter] = useState<CorrectionFilter>("pending");
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<CorrectionItem[]>([]);
  const [total, setTotal] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [nextStatus, setNextStatus] = useState<CorrectionStatus>("in_progress");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const load = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true); setError(""); setItems([]);
    try {
      const result = await correctionsApi.list(filter, offset);
      if (request === generation.current) { setItems(result.items); setTotal(result.total); }
    } catch (cause) { if (request === generation.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (request === generation.current) setLoading(false); }
  }, [filter, offset]);
  useEffect(() => { void load(); return () => { generation.current += 1; }; }, [load]);
  async function save(item: CorrectionItem) {
    if (note.trim().length < 2) { setError("请填写至少两个字符的处理说明。"); return; }
    setSaving(true); setError("");
    try {
      await correctionsApi.review(item.id, nextStatus, note.trim());
      setEditing(null); setNote("");
      if (items.length === 1 && offset > 0 && filter !== "all" && nextStatus !== filter) setOffset(Math.max(0, offset - 50));
      else await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  }
  return <>
    <PageTopbar eyebrow="CONTENT / 内容维护" title="读者内容纠错" description="核对读者提供的原文与位置，更新处理状态。处理说明会显示在读者自己的纠错记录中。" aside={<span className="moderation-count">{total} 条记录</span>} />
    <div className="moderation-tabs" role="tablist" aria-label="纠错状态">{statuses.map((status) => <button key={status.value} role="tab" disabled={saving} aria-selected={filter === status.value} onClick={() => { setFilter(status.value); setOffset(0); setEditing(null); }}>{status.label}</button>)}</div>
    {error ? <p className="moderation-error" role="alert">{error} <button type="button" disabled={saving} onClick={() => void load()}>重新读取</button></p> : null}
    {loading ? <p className="moderation-empty" role="status">正在读取纠错记录…</p> : !items.length && !error ? <p className="moderation-empty">当前没有这类纠错记录。</p> : null}
    <section className="moderation-docket">{items.map((item) => <article key={item.id}>
      <header><div><span>{item.contentType.toUpperCase()} · {item.locationLabel || item.sectionId || "资料"}</span><h2>{item.contentTitle}</h2></div><b>{categories[item.category] || item.category}</b></header>
      <p className="moderation-comment">{item.details}</p>
      {item.quote ? <blockquote>{item.quote}</blockquote> : null}
      <p className="moderation-context">阅读位置 <code>{item.contentUrl}</code></p>
      <p className="moderation-context">内容编号 <code>{item.contentId}</code> · 反馈编号 <code>{item.id}</code></p>
      <p>{statuses.find((status) => status.value === item.status)?.label} · {new Date(item.createdAt).toLocaleString("zh-CN")}</p>
      {item.resolutionNote ? <p>处理说明：{item.resolutionNote}</p> : null}
      <footer>{editing === item.id ? <form onSubmit={(event) => { event.preventDefault(); void save(item); }} style={{ width: "100%" }}>
        <label>处理状态 <select aria-label="处理状态" value={nextStatus} disabled={saving} onChange={(event) => setNextStatus(event.target.value as CorrectionStatus)}>{statuses.filter((status) => status.value !== "all").map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}</select></label>
        <label style={{ display: "block", marginTop: 12 }}>处理说明<textarea aria-label="处理说明" style={{ display: "block", width: "100%", marginTop: 8, padding: 12 }} required minLength={2} maxLength={1000} rows={3} disabled={saving} value={note} onChange={(event) => setNote(event.target.value)} placeholder="说明核查结果、修正内容或需要补充的信息" /></label>
        <div style={{ marginTop: 12 }}><button type="submit" disabled={saving || note.trim().length < 2}>{saving ? "保存中…" : "保存处理结果"}</button><button type="button" disabled={saving} onClick={() => setEditing(null)}>取消</button></div>
      </form> : <button type="button" disabled={saving} onClick={() => { setEditing(item.id); setNextStatus(item.status === "pending" ? "in_progress" : item.status); setNote(item.resolutionNote || ""); }}>处理纠错</button>}</footer>
    </article>)}</section>
    {total > 50 ? <nav className="moderation-tabs" aria-label="纠错分页"><button disabled={loading || saving || offset === 0} onClick={() => { setOffset(Math.max(0, offset - 50)); setEditing(null); }}>上一页</button><span>第 {Math.floor(offset / 50) + 1} 页，共 {Math.ceil(total / 50)} 页</span><button disabled={loading || saving || offset + 50 >= total} onClick={() => { setOffset(offset + 50); setEditing(null); }}>下一页</button></nav> : null}
  </>;
}
