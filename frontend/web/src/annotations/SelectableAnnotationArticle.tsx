import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAccountSessionStore } from "../account/session";
import { useFeatureFlag } from "../featureFlags";
import { AnnotationDiscussionPanel } from "./AnnotationDiscussionPanel";
import { CommentVisibilityControl } from "./CommentVisibilityControl";
import { renderAnnotationMarks, textAnchorFromRange } from "./domAnchors";
import type { AnnotationSubject, AnnotationVisibility, TextAnchor } from "./types";
import { useAnnotationThreads } from "./useAnnotationThreads";
import "./annotations.css";

interface SelectionState {
  anchor: TextAnchor;
  left: number;
  top: number;
}

export function SelectableAnnotationArticle({ subject, children }: { subject: AnnotationSubject; children: ReactNode }) {
  const enabled = useFeatureFlag("reader.annotations");
  const currentUserId = useAccountSessionStore((state) => state.userId);
  const access = enabled && Boolean(currentUserId);
  const annotations = useAnnotationThreads(subject, access);
  const rootRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<SelectionState>();
  const [commentOpen, setCommentOpen] = useState(false);
  const [comment, setComment] = useState("");
  const [commentVisibility, setCommentVisibility] = useState<AnnotationVisibility>("public");
  const [activeId, setActiveId] = useState<string>();
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const active = annotations.threads.find((thread) => thread.id === activeId);

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("discussion");
    if (requested && annotations.threads.some((thread) => thread.id === requested)) setActiveId(requested);
  }, [annotations.threads]);

  useEffect(() => {
    if (!rootRef.current) return;
    renderAnnotationMarks(rootRef.current, annotations.threads, setActiveId);
  }, [annotations.threads, children]);

  function captureSelection() {
    const nativeSelection = window.getSelection();
    const root = rootRef.current;
    if (!access || !root || !nativeSelection || nativeSelection.isCollapsed || !nativeSelection.rangeCount) {
      setSelection(undefined);
      setCommentOpen(false);
      return;
    }
    const range = nativeSelection.getRangeAt(0);
    const anchor = textAnchorFromRange(root, range);
    if (!anchor) return;
    const rect = range.getBoundingClientRect();
    setSelection({
      anchor,
      left: Math.min(window.innerWidth - 100, Math.max(100, rect.left + rect.width / 2)),
      top: rect.top > 100 ? rect.top - 10 : rect.bottom + 10,
    });
    setCommentOpen(false);
  }

  function capturePointerSelection() {
    window.setTimeout(captureSelection, 0);
  }

  function clearSelection() {
    window.getSelection()?.removeAllRanges();
    setSelection(undefined);
    setCommentOpen(false);
  }

  async function save(initialComment?: string, visibility: AnnotationVisibility = "public") {
    if (!selection || saving) return;
    setNotice("");
    setSaving(true);
    try {
      const created = await annotations.create(selection.anchor, initialComment, visibility);
      clearSelection();
      setComment("");
      setCommentVisibility("public");
      if (initialComment) setActiveId(created.id);
      else setNotice("已划线");
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div ref={rootRef} onPointerUp={capturePointerSelection} onKeyUp={captureSelection}>{children}</div>
      {selection ? (
        <div className="annotation-selection-tools" style={{ left: selection.left, top: selection.top }} role="toolbar" aria-label="选中文字工具">
          <div><button type="button" disabled={saving} onClick={() => void save()}>划线</button><button type="button" disabled={saving} onClick={() => setCommentOpen((value) => !value)}>写想法</button></div>
          {commentOpen ? <section><textarea autoFocus value={comment} maxLength={2000} onChange={(event) => setComment(event.target.value)} placeholder="写下此刻的想法……" /><CommentVisibilityControl value={commentVisibility} onChange={setCommentVisibility} disabled={saving} /><button type="button" disabled={saving || !comment.trim()} onClick={() => void save(comment.trim(), commentVisibility)}>{saving ? "保存中…" : "保存想法"}</button></section> : null}
        </div>
      ) : null}
      {notice || annotations.error ? <button type="button" className="annotation-notice" onClick={() => setNotice("")}>{notice || annotations.error}</button> : null}
      {active && currentUserId ? <AnnotationDiscussionPanel key={active.id}
        thread={active}
        currentUserId={currentUserId}
        onClose={() => setActiveId(undefined)}
        onComment={(body, parentCommentId, visibility) => annotations.comment(active.id, body, parentCommentId, visibility)}
        onReport={(commentId, reason, details) => annotations.report(active.id, commentId, reason, details)}
      /> : null}
    </>
  );
}
