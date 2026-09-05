import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CommentVisibilityControl } from "../../annotations/CommentVisibilityControl";
import type { AnnotationVisibility } from "../../annotations/types";

export function BookThoughtComposer({ quote, value, visibility, saving, error, panelClass, onChange, onVisibilityChange, onSave, onClose }: {
  quote: string;
  value: string;
  visibility: AnnotationVisibility;
  saving: boolean;
  error: string;
  panelClass: string;
  onChange: (value: string) => void;
  onVisibilityChange: (value: AnnotationVisibility) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: window.innerHeight });

  useLayoutEffect(() => {
    const visual = window.visualViewport;
    const measure = () => setViewport({ top: visual?.offsetTop ?? 0, height: visual?.height ?? window.innerHeight });
    measure();
    visual?.addEventListener("resize", measure);
    visual?.addEventListener("scroll", measure);
    window.addEventListener("resize", measure);
    const dialog = dialogRef.current;
    dialog?.showModal();
    inputRef.current?.focus({ preventScroll: true });
    return () => {
      dialog?.close();
      visual?.removeEventListener("resize", measure);
      visual?.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, []);

  return createPortal(<dialog ref={dialogRef} className="book-thought-dialog" aria-label="写想法" aria-modal="true"
    style={{ top: viewport.top, height: viewport.height }}
    onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}
    onKeyDown={(event) => event.stopPropagation()}>
    <form className={`book-thought-composer ${panelClass}`} onSubmit={(event) => { event.preventDefault(); onSave(); }}>
      <header className="book-thought-composer__header">
        <h2>写想法</h2>
        <button type="button" onClick={onClose} disabled={saving} aria-label="取消写想法">取消</button>
      </header>
      <blockquote className="book-thought-composer__quote" aria-label="所选原文" tabIndex={0}>{quote}</blockquote>
      <textarea ref={inputRef} autoFocus className="reader-thought-input" aria-label="想法内容" value={value} maxLength={2000} disabled={saving}
        onChange={(event) => onChange(event.target.value)} placeholder="写下此刻的想法……" rows={4} />
      {error && <p className="book-thought-composer__error" role="alert">{error}</p>}
      <footer className="book-thought-composer__footer">
        <CommentVisibilityControl value={visibility} onChange={onVisibilityChange} disabled={saving} />
        <button className="book-thought-composer__save" type="submit" disabled={saving || !value.trim()}>{saving ? "保存中…" : "保存"}</button>
      </footer>
    </form>
  </dialog>, document.body);
}
