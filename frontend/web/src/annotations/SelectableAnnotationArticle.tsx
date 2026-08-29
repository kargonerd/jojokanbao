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
  above: boolean;
  left: number;
  top: number;
}

export function SelectableAnnotationArticle({
  subject,
  children,
  onExplain,
}: {
  subject: AnnotationSubject;
  children: ReactNode;
  onExplain?: (anchor: TextAnchor) => void;
}) {
  const enabled = useFeatureFlag("reader.annotations");
  const currentUserId = useAccountSessionStore((state) => state.userId);
  const access = enabled && Boolean(currentUserId);
  const explanationAccess = Boolean(currentUserId && onExplain);
  const annotations = useAnnotationThreads(subject, access, currentUserId);
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
    if (!root || !nativeSelection || nativeSelection.isCollapsed || !nativeSelection.rangeCount) {
      setSelection(undefined);
      setCommentOpen(false);
      return;
    }
    const range = nativeSelection.getRangeAt(0);
    const anchor = textAnchorFromRange(root, range);
    if (!anchor) return;
    const rect = range.getBoundingClientRect();
    const toolbarHalfWidth = Math.min(128, Math.max(0, window.innerWidth / 2 - 8));
    const above = rect.top > 110;
    setSelection({
      anchor,
      above,
      left: Math.min(window.innerWidth - toolbarHalfWidth, Math.max(toolbarHalfWidth, rect.left + rect.width / 2)),
      top: above ? rect.top - 10 : rect.bottom + 10,
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

  async function copySelection(): Promise<void> {
    if (!selection) return;
    try {
      await navigator.clipboard.writeText(selection.anchor.quote);
    } catch {
      const input = document.createElement("textarea");
      input.value = selection.anchor.quote;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.append(input);
      input.select();
      document.execCommand?.("copy");
      input.remove();
    }
    clearSelection();
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

  function explain() {
    if (!selection || !onExplain) return;
    onExplain(selection.anchor);
    clearSelection();
  }

  return (
    <>
      <div ref={rootRef} onPointerUp={capturePointerSelection} onKeyUp={captureSelection}>{children}</div>
      {selection ? (
        <div className={`fixed z-[65] -translate-x-1/2 font-sans ${selection.above ? "-translate-y-full" : ""}`} style={{ left: selection.left, top: selection.top }}>
          <div className="flex border border-rule bg-paper text-ink shadow-[3px_6px_20px_rgba(0,0,0,.18)]" role="toolbar" aria-label="选中文字工具">
            <button type="button" onClick={() => void copySelection()} className="reader-selection-action">复制</button>
            {access ? <><button type="button" disabled={saving} onClick={() => void save()} className="reader-selection-action">划线</button><button type="button" disabled={saving} onClick={() => setCommentOpen((value) => !value)} className="reader-selection-action">写想法</button></> : null}
            {explanationAccess ? <button type="button" disabled={saving} onClick={explain} className="reader-selection-action relative text-red" aria-label="AI 解释">AI 解释<span aria-hidden="true" className="absolute right-1 top-1 text-[6px] font-bold leading-none tracking-normal">Beta</span></button> : null}
          </div>
          {commentOpen ? <div className="mt-1 w-72 border border-rule bg-paper p-3 text-ink shadow-[3px_6px_20px_rgba(0,0,0,.16)]"><textarea autoFocus value={comment} maxLength={2000} rows={3} onChange={(event) => setComment(event.target.value)} placeholder="写下此刻的想法……" className="reader-thought-input block w-full resize-none border-0 border-b border-rule bg-transparent px-0 py-1 font-serif text-sm leading-6 text-current" /><div className="mt-2 flex items-center justify-between gap-3"><CommentVisibilityControl value={commentVisibility} onChange={setCommentVisibility} disabled={saving} /><button type="button" disabled={saving || !comment.trim()} onClick={() => void save(comment.trim(), commentVisibility)} className="cursor-pointer border-0 bg-transparent p-0 text-xs font-bold text-red disabled:opacity-30">{saving ? "保存中…" : "保存"}</button></div></div> : null}
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
