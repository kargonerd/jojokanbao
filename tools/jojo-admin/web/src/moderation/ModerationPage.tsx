import { useCallback, useEffect, useRef, useState } from "react";
import { PageTopbar } from "../components/PageTopbar";
import { moderationApi } from "./api";
import type { ModerationAction, ModerationItem, ModerationStatus } from "./types";

const statuses: Array<{ value: ModerationStatus; label: string }> = [
  { value: "pending", label: "待审核" },
  { value: "resolved", label: "已处理" },
  { value: "dismissed", label: "已驳回" },
  { value: "all", label: "全部" },
];

const reasonLabels: Record<string, string> = {
  spam: "广告或刷屏",
  abuse: "辱骂或攻击",
  harassment: "骚扰",
  misinformation: "明显错误信息",
  other: "其他",
};

export function ModerationPage() {
  const [status, setStatus] = useState<ModerationStatus>("pending");
  const [items, setItems] = useState<ModerationItem[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(0);

  const load = useCallback(async (nextStatus: ModerationStatus) => {
    const currentRequest = ++requestId.current;
    setBusy(true);
    setError("");
    setItems([]);
    try {
      const loaded = await moderationApi.list(nextStatus);
      if (requestId.current === currentRequest) setItems(loaded);
    } catch (cause) {
      if (requestId.current === currentRequest) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (requestId.current === currentRequest) setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(status);
    return () => { requestId.current += 1; };
  }, [load, status]);

  async function act(item: ModerationItem, action: ModerationAction) {
    if (reason.trim().length < 2) {
      setSelectedId(item.commentId);
      setError("执行审核前请填写至少两个字符的理由。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await moderationApi.moderate(item.commentId, action, reason.trim());
      setReason("");
      setSelectedId(undefined);
      await load(status);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  return (
    <>
      <PageTopbar eyebrow="TRUST & SAFETY / 审核台" title="划线评论审核" description="举报按评论聚合。管理员 token 仅保留在本机服务端，不进入浏览器。" aside={<span className="moderation-count">{items.length} 条记录</span>} />
      <div className="moderation-tabs" role="tablist" aria-label="审核状态">
        {statuses.map((entry) => <button key={entry.value} role="tab" aria-selected={status === entry.value} onClick={() => { setStatus(entry.value); setSelectedId(undefined); setReason(""); }}>{entry.label}</button>)}
      </div>
      {error ? <p className="moderation-error" role="alert">{error}</p> : null}
      {busy && items.length === 0 ? <p className="moderation-empty">正在读取审核队列…</p> : null}
      {!busy && items.length === 0 ? <p className="moderation-empty">当前队列为空，没有需要处理的评论。</p> : null}
      <section className="moderation-docket">
        {items.map((item) => {
          const hasPending = item.reports.some((report) => report.status === "pending");
          const hasResolved = item.reports.some((report) => report.status === "resolved");
          const canHide = item.commentStatus === "visible" && hasPending;
          const canRestore = item.commentStatus === "hidden" && hasResolved;
          const canDismiss = hasPending;
          return <article key={`${status}:${item.commentId}`} className={item.commentStatus === "hidden" ? "is-hidden" : ""}>
            <header><div><span>{item.contentType.toUpperCase()} · {item.contentTitle}</span><h2>{item.commentAuthorName}</h2></div><b>{item.reportCount} 次举报</b></header>
            <blockquote>{item.quote}</blockquote>
            <p className="moderation-comment">{item.commentBody}</p>
            <ol>{item.reports.map((report) => <li key={report.id}><b>{reasonLabels[report.reason] || report.reason}</b><span>{report.reporterName}</span>{report.details ? <p>{report.details}</p> : null}</li>)}</ol>
            {item.contentUrl ? <p className="moderation-context">站内位置 <code>{item.contentUrl}</code></p> : null}
            {canHide || canRestore || canDismiss ? <footer>
              {selectedId === item.commentId ? <input autoFocus value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} placeholder="填写审核理由" /> : <button type="button" className="moderation-reason" onClick={() => { setSelectedId(item.commentId); setReason(""); }}>填写审核理由</button>}
              <div>
                {canHide ? <button type="button" disabled={busy} onClick={() => void act(item, "hide")}>隐藏评论</button> : null}
                {canRestore ? <button type="button" disabled={busy} onClick={() => void act(item, "restore")}>恢复评论</button> : null}
                {canDismiss ? <button type="button" disabled={busy} onClick={() => void act(item, "dismiss")}>驳回举报</button> : null}
              </div>
            </footer> : null}
          </article>;
        })}
      </section>
    </>
  );
}
