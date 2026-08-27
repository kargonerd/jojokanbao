import { useState } from "react";
import { CommentVisibilityControl } from "./CommentVisibilityControl";
import { ANNOTATION_REPORT_LABELS, type AnnotationReportReason, type AnnotationThread, type AnnotationVisibility } from "./types";
import "./annotations.css";

interface AnnotationDiscussionPanelProps {
  thread: AnnotationThread;
  currentUserId: string;
  onClose: () => void;
  onComment: (body: string, parentCommentId?: string, visibility?: AnnotationVisibility) => Promise<unknown>;
  onReport: (commentId: string, reason: AnnotationReportReason, details?: string) => Promise<unknown>;
}

function displayTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

export function AnnotationDiscussionPanel({ thread, currentUserId, onClose, onComment, onReport }: AnnotationDiscussionPanelProps) {
  const [draft, setDraft] = useState("");
  const [visibility, setVisibility] = useState<AnnotationVisibility>("public");
  const [replyTo, setReplyTo] = useState<string>();
  const [reporting, setReporting] = useState<string>();
  const [reportReason, setReportReason] = useState<AnnotationReportReason>("spam");
  const [reportDetails, setReportDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const reply = thread.comments.find((comment) => comment.id === replyTo);

  async function submitComment() {
    if (!draft.trim() || busy) return;
    setBusy(true);
    setNotice("");
    try {
      await onComment(draft.trim(), replyTo, visibility);
      setDraft("");
      setReplyTo(undefined);
      setVisibility("public");
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function submitReport(commentId: string) {
    if (busy) return;
    setBusy(true);
    setNotice("");
    try {
      await onReport(commentId, reportReason, reportDetails);
      setReporting(undefined);
      setReportDetails("");
      setNotice("举报已提交，管理员会在 Workbench 中审核。");
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="annotation-panel" aria-label="划线评论">
      <header className="annotation-panel__header">
        <div><span>READER MARGINALIA</span><h2>划线评论</h2></div>
        <button type="button" onClick={onClose} aria-label="关闭划线评论">×</button>
      </header>
      <blockquote>{thread.quote}</blockquote>
      <div className="annotation-panel__meta">{thread.authorName} 划线 · {displayTime(thread.createdAt)}</div>

      <ol className="annotation-comments">
        {thread.comments.map((comment) => {
          const parent = thread.comments.find((candidate) => candidate.id === comment.parentCommentId);
          return (
            <li key={comment.id}>
              <div className="annotation-comment__byline"><span><b>{comment.authorName}</b>{comment.visibility === "private" ? <em>仅自己可见</em> : null}</span><time>{displayTime(comment.createdAt)}</time></div>
              {parent ? <small>回复 {parent.authorName}</small> : null}
              <p>{comment.body}</p>
              {comment.visibility !== "private" ? <div className="annotation-comment__actions">
                <button type="button" onClick={() => { setReplyTo(comment.id); setReporting(undefined); }}>回复</button>
                {comment.authorId !== currentUserId ? (
                  <button type="button" disabled={comment.reportedByMe} onClick={() => { setReporting(comment.id); setReplyTo(undefined); }}>
                    {comment.reportedByMe ? "已举报" : "举报"}
                  </button>
                ) : null}
              </div> : null}
              {reporting === comment.id ? (
                <div className="annotation-report-form">
                  <select value={reportReason} onChange={(event) => setReportReason(event.target.value as AnnotationReportReason)} aria-label="举报原因">
                    {Object.entries(ANNOTATION_REPORT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                  <textarea value={reportDetails} maxLength={1000} onChange={(event) => setReportDetails(event.target.value)} placeholder="补充说明（选填）" />
                  <div><button type="button" onClick={() => setReporting(undefined)}>取消</button><button type="button" disabled={busy} onClick={() => void submitReport(comment.id)}>提交举报</button></div>
                </div>
              ) : null}
            </li>
          );
        })}
        {thread.comments.length === 0 ? <li className="annotation-comments__empty">还没有评论。写下第一条回应。</li> : null}
      </ol>

      <footer className="annotation-composer">
        {reply ? <div>回复 {reply.authorName}<button type="button" onClick={() => setReplyTo(undefined)}>取消</button></div> : null}
        <textarea value={draft} maxLength={2000} onChange={(event) => setDraft(event.target.value)} placeholder="接着评论……" />
        <CommentVisibilityControl value={visibility} onChange={setVisibility} disabled={busy} />
        <button type="button" disabled={busy || !draft.trim()} onClick={() => void submitComment()}>{busy ? "发送中…" : "发表评论"}</button>
        {notice ? <p role="status">{notice}</p> : null}
      </footer>
    </aside>
  );
}
