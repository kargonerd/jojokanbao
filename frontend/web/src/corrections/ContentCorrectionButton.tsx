import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation } from "react-router-dom";
import { contentCorrectionCategoryLabels, contentCorrectionStatusLabels, createCorrectionRequestId } from "@jojo/auth";
import type { ContentCorrection, ContentCorrectionCategory, ContentCorrectionSource } from "@jojo/auth";
import { useAccountSessionStore } from "../account/session";
import { loadMyContentCorrections, submitContentCorrection } from "./api";
import "./corrections.css";

export interface ContentCorrectionButtonProps {
  source: ContentCorrectionSource;
  className?: string;
  label?: string;
}

export function ContentCorrectionButton({ source, className, label = "内容纠错" }: ContentCorrectionButtonProps) {
  const [snapshot, setSnapshot] = useState<ContentCorrectionSource | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => { setSnapshot(null); trigger.current?.focus(); };
  return <>
    <button ref={trigger} type="button" className={className || "correction-trigger"} onClick={() => {
      const quote = source.quote || window.getSelection()?.toString().trim().slice(0, 4000);
      setSnapshot({ ...source, quote });
    }}>{label}</button>
    {snapshot ? createPortal(<ContentCorrectionDialog source={snapshot} onClose={close} />, document.body) : null}
  </>;
}

export function ContentCorrectionDialog({ source, onClose }: { source: ContentCorrectionSource; onClose: () => void }) {
  const userId = useAccountSessionStore((state) => state.userId);
  const initialized = useAccountSessionStore((state) => state.initialized);
  const location = useLocation();
  const titleId = useId();
  const dialog = useRef<HTMLElement>(null);
  const requestId = useRef(createCorrectionRequestId());
  const submitting = useRef(false);
  const mounted = useRef(true);
  const initialOwner = useRef(userId);
  const currentOwner = useRef(userId);
  currentOwner.current = userId;
  const [category, setCategory] = useState<ContentCorrectionCategory>("typo");
  const [details, setDetails] = useState("");
  const [quote, setQuote] = useState(source.quote || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<ContentCorrection | null>(null);
  const [history, setHistory] = useState<ContentCorrection[]>([]);
  const [historyError, setHistoryError] = useState("");
  const returnTo = `${location.pathname}${location.search}${location.hash}`;

  useEffect(() => {
    dialog.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (initialOwner.current !== userId) {
      setDetails(""); setQuote(""); setSaved(null); setHistory([]); setError("");
      onClose();
    }
  }, [userId, onClose]);
  useEffect(() => {
    let active = true;
    setHistory([]);
    setHistoryError("");
    if (userId) void loadMyContentCorrections(source).then((items) => { if (active) setHistory(items); })
      .catch(() => { if (active) setHistoryError("暂时无法读取此前的纠错记录。"); });
    return () => { active = false; };
  }, [source.contentType, source.contentId, userId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || !userId) return;
    const owner = userId;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const record = await submitContentCorrection({ ...source, quote }, category, details, requestId.current, owner);
      if (!mounted.current || currentOwner.current !== owner) return;
      setSaved(record);
      setHistory((items) => [record, ...items.filter((item) => item.id !== record.id)]);
    } catch (cause) { if (mounted.current && currentOwner.current === owner) setError(cause instanceof Error ? cause.message : "提交失败，请重试。"); }
    finally { submitting.current = false; if (mounted.current && currentOwner.current === owner) setBusy(false); }
  }
  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") { event.stopPropagation(); if (!busy) onClose(); }
    if (event.key !== "Tab") return;
    const nodes = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]');
    if (!nodes?.length) return;
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
  }
  if (initialOwner.current !== userId) return null;
  return <div className="correction-backdrop" onClick={() => { if (!busy) onClose(); }}>
    <section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} className="correction-dialog" onClick={(event) => event.stopPropagation()} onKeyDown={onKeyDown}>
      <header><div><span>帮助完善资料</span><h2 id={titleId}>内容纠错</h2></div><button type="button" onClick={onClose} disabled={busy} aria-label="关闭内容纠错">×</button></header>
      <p className="correction-source"><b>{source.contentTitle}</b>{source.locationLabel || source.sectionId ? <span>{source.locationLabel || source.sectionId}</span> : null}</p>
      {!initialized ? <p role="status">正在确认登录状态…</p> : !userId ? <div className="correction-signin"><p>登录后可提交纠错，并查看处理结果。当前阅读位置会保留。</p><Link to={`/account?returnTo=${encodeURIComponent(returnTo)}`} onClick={onClose}>登录后纠错 →</Link></div> : saved ? <div role="status" className="correction-success"><h3>纠错已记录</h3><p>感谢你帮助完善这份资料。你可以再次打开这里查看处理结果。</p><p>编号：{saved.id.slice(0, 8)} · {contentCorrectionStatusLabels[saved.status]}</p><button type="button" onClick={onClose}>继续阅读</button></div> : <form onSubmit={(event) => void submit(event)}>
        <label>问题类型<select value={category} disabled={busy} onChange={(event) => setCategory(event.target.value as ContentCorrectionCategory)}>{Object.entries(contentCorrectionCategoryLabels).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
        <label>问题说明<textarea autoFocus value={details} disabled={busy} minLength={2} maxLength={2000} required rows={4} placeholder="例如：第二段中的“工路”应为“公路”；或说明缺少哪一页。" onChange={(event) => setDetails(event.target.value)} /></label>
        <label>原文摘录（可选）<textarea value={quote} disabled={busy} maxLength={4000} rows={2} placeholder="粘贴有问题的原文，方便核查" onChange={(event) => setQuote(event.target.value)} /></label>
        <p className="correction-hint">提交会附上资料名称和当前阅读位置，仅你与编辑可查看。</p>
        {error ? <p role="alert" className="correction-error">{error}</p> : null}
        <footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button type="submit" disabled={busy || details.trim().length < 2}>{busy ? "正在提交…" : "提交纠错"}</button></footer>
      </form>}
      {userId && (history.length > 0 || historyError) ? <details className="correction-history"><summary>我对这份资料的纠错{history.length ? `（${history.length}）` : ""}</summary>{historyError ? <p>{historyError}</p> : history.map((item) => <article key={item.id}><div><b>{contentCorrectionStatusLabels[item.status]}</b><time>{new Date(item.createdAt).toLocaleDateString("zh-CN")}</time></div><p>{item.details}</p>{item.resolutionNote ? <p className="correction-reply">编辑答复：{item.resolutionNote}</p> : null}</article>)}</details> : null}
    </section>
  </div>;
}
