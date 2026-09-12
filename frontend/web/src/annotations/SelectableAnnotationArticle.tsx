import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ReaderSelectionRect } from "@jojo/ui/reader-selection";
import { IoCopyOutline, IoCreateOutline, IoSparklesOutline } from "react-icons/io5";
import { ReaderSelectionPopover } from "../reading/ReaderSelectionPopover";
import { useAccountSessionStore } from "../account/session";
import { AnnotationDiscussionPanel } from "./AnnotationDiscussionPanel";
import { CommentVisibilityControl } from "./CommentVisibilityControl";
import { renderAnnotationMarks, textAnchorFromRange } from "./domAnchors";
import type { AnnotationSubject, AnnotationVisibility, TextAnchor } from "./types";
import { useAnnotationThreads } from "./useAnnotationThreads";
import "./annotations.css";

interface SelectionState {
  anchor: TextAnchor;
  rect: ReaderSelectionRect;
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
  const currentUserId = useAccountSessionStore((state) => state.userId);
  const access = Boolean(currentUserId);
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

  const captureSelection = useCallback(() => {
    if (document.activeElement?.closest(".book-selection-tools")) return;
    const nativeSelection = window.getSelection();
    const root = rootRef.current;
    if (!root || !nativeSelection || nativeSelection.isCollapsed || !nativeSelection.rangeCount) {
      setSelection(undefined);
      setCommentOpen(false);
      return;
    }
    const range = nativeSelection.getRangeAt(0);
    const anchor = textAnchorFromRange(root, range);
    if (!anchor) { setSelection(undefined); return; }
    const rect = range.getBoundingClientRect();
    setSelection({
      anchor,
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
    });
    setCommentOpen(false);
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const update = () => { clearTimeout(timer); timer = setTimeout(captureSelection, 90); };
    document.addEventListener("selectionchange", update);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [captureSelection]);

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
        <ReaderSelectionPopover rect={selection.rect} width={(1 + Number(access) * 2 + Number(explanationAccess)) * 72}>
          <div className="book-selection-actions" role="toolbar" aria-label="选中文字工具">
            <button type="button" onClick={() => void copySelection()} className="reader-selection-action"><IoCopyOutline aria-hidden="true" /><span>复制</span></button>
            {access ? <><button type="button" disabled={saving} onClick={() => void save()} className="reader-selection-action"><span aria-hidden="true" className="book-selection-underline">A</span><span>划线</span></button><button type="button" disabled={saving} onClick={() => setCommentOpen((value) => !value)} className="reader-selection-action"><IoCreateOutline aria-hidden="true" /><span>写想法</span></button></> : null}
            {explanationAccess ? <button type="button" disabled={saving} onClick={explain} className="reader-selection-action" aria-label="AI 解释"><IoSparklesOutline aria-hidden="true" /><span>AI 解释</span></button> : null}
          </div>
          {commentOpen ? <div className="mt-1 w-72 border border-rule bg-paper p-3 text-ink shadow-[3px_6px_20px_rgba(0,0,0,.16)]"><textarea autoFocus value={comment} maxLength={2000} rows={3} onChange={(event) => setComment(event.target.value)} placeholder="写下此刻的想法……" className="reader-thought-input block w-full resize-none border-0 border-b border-rule bg-transparent px-0 py-1 font-serif text-sm leading-6 text-current" /><div className="mt-2 flex items-center justify-between gap-3"><CommentVisibilityControl value={commentVisibility} onChange={setCommentVisibility} disabled={saving} /><button type="button" disabled={saving || !comment.trim()} onClick={() => void save(comment.trim(), commentVisibility)} className="cursor-pointer border-0 bg-transparent p-0 text-xs font-bold text-red disabled:opacity-30">{saving ? "保存中…" : "保存"}</button></div></div> : null}
        </ReaderSelectionPopover>
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
