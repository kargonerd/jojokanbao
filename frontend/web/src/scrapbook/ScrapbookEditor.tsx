import { useEffect, useState, type FormEvent } from "react";
import { Modal } from "@jojo/ui";
import type { ScrapbookDraft } from "@jojo/auth";
import "./scrapbook.css";

export function ScrapbookEditor({ initial, collections = [], saving, error, onSave, onClose }: {
  initial: ScrapbookDraft; collections?: string[]; saving: boolean; error: string;
  onSave: (draft: ScrapbookDraft) => void; onClose: () => void;
}) {
  const [quote, setQuote] = useState(initial.quote);
  const [note, setNote] = useState(initial.note);
  const [collection, setCollection] = useState(initial.collection);
  useEffect(() => { setQuote(initial.quote); setNote(initial.note); setCollection(initial.collection); }, [initial]);
  const submit = (event: FormEvent) => { event.preventDefault(); onSave({ ...initial, quote, note, collection }); };
  return <Modal open onClose={() => { if (!saving) onClose(); }} size="medium" surface="bare">
    <section className="clipping-editor" role="dialog" aria-modal="true" aria-label="保存剪报">
      <header><h2>保存剪报</h2><button type="button" onClick={onClose} disabled={saving}>取消</button></header>
      <p className="clipping-source">{initial.contentTitle}　{initial.locationLabel}</p>
      <form onSubmit={submit}>
        <label>原文摘录<textarea autoFocus rows={5} maxLength={6000} value={quote} disabled={saving} onChange={(event) => setQuote(event.target.value)} placeholder="填写或整理摘录；也可以只写笔记" /></label>
        <label>我的笔记<textarea rows={3} maxLength={8000} value={note} disabled={saving} onChange={(event) => setNote(event.target.value)} placeholder="这条材料值得记下什么？" /></label>
        <label>专题<input list="clipping-collections" maxLength={80} value={collection} disabled={saving} onChange={(event) => setCollection(event.target.value)} placeholder="留空则不分类，也可输入新专题" /></label>
        <datalist id="clipping-collections">{collections.map((name) => <option key={name} value={name} />)}</datalist>
        <p className="clipping-source">仅自己可见，保存后可在其他设备的剪报本中查看。</p>
        {error && <p role="alert" className="clipping-error">{error}</p>}
        <footer><button className="clipping-primary" disabled={saving || (!quote.trim() && !note.trim())} type="submit">{saving ? "保存中…" : "保存到剪报本"}</button></footer>
      </form>
    </section>
  </Modal>;
}
