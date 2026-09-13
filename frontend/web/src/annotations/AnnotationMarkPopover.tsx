import { useEffect, useRef, useState } from "react";
import { IoChatbubbleOutline, IoCopyOutline, IoCreateOutline } from "react-icons/io5";
import type { ReaderSelectionRect } from "@jojo/ui/reader-selection";
import { ReaderSelectionPopover } from "../reading/ReaderSelectionPopover";
import type { AnnotationThread } from "./types";
import "./annotations.css";

export function DeleteUnderlineIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <path d="m6 18 6-15 6 15M8 13h8M5 22h14M3 3l18 18" />
  </svg>;
}

export function AnnotationMarkPopover({ thread, rect, onClose, onDelete, onDiscuss }: {
  thread: AnnotationThread;
  rect: ReaderSelectionRect;
  onClose: () => void;
  onDelete: () => Promise<unknown>;
  onDiscuss: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const pending = useRef(false);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const dismiss = (event: Event) => {
      if (event.target instanceof Element && event.target.closest(".book-selection-tools")) return;
      close.current();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close.current(); };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, []);

  async function run(action: () => Promise<unknown>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setNotice("");
    try {
      await action();
      onClose();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "操作失败，请重试。");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return <ReaderSelectionPopover rect={rect} width={288}>
    <div className="book-selection-actions" role="toolbar" aria-label="划线工具">
      <button type="button" disabled={busy} className="reader-selection-action" onClick={() => void run(() => navigator.clipboard.writeText(thread.quote))}><IoCopyOutline aria-hidden="true" /><span>复制</span></button>
      {thread.underlinedByMe ? <button type="button" disabled={busy} className="reader-selection-action" onClick={() => void run(onDelete)}><DeleteUnderlineIcon /><span>{busy ? "处理中…" : "删除划线"}</span></button> : null}
      <button type="button" disabled={busy} className="reader-selection-action" onClick={onDiscuss}><IoCreateOutline aria-hidden="true" /><span>写想法</span></button>
      <button type="button" disabled={busy} className="reader-selection-action" onClick={onDiscuss}><IoChatbubbleOutline aria-hidden="true" /><span>查看想法</span></button>
    </div>
    {notice ? <p className="annotation-mark-notice" role="status">{notice}</p> : null}
  </ReaderSelectionPopover>;
}
