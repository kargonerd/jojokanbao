import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import type { ScrapbookDraft, ScrapbookSource } from "@jojo/auth";
import { useAccountSessionStore } from "../account/session";
import { scrapbookRepository } from "./api";
import { ScrapbookEditor } from "./ScrapbookEditor";

export function ScrapbookCapture({ source, quote = "", onClose, onSaved }: {
  source: ScrapbookSource; quote?: string; onClose: () => void; onSaved?: () => void;
}) {
  const userId = useAccountSessionStore((state) => state.userId);
  const location = useLocation();
  const [owner] = useState(userId);
  const mounted = useRef(false);
  const invalidated = useRef(false);
  const submitting = useRef(false);
  const [initial] = useState<ScrapbookDraft>(() => ({ ...source, quote: quote.slice(0, 6000), note: "", collection: "" }));
  const [collections, setCollections] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useLayoutEffect(() => {
    if (owner !== userId && !invalidated.current) {
      invalidated.current = true;
      onClose();
    }
  }, [owner, userId, onClose]);
  function ownsCapture() {
    return mounted.current && !invalidated.current && Boolean(owner)
      && useAccountSessionStore.getState().userId === owner;
  }
  useEffect(() => {
    let active = true;
    if (owner === userId && ownsCapture()) void scrapbookRepository(owner || "").then((repo) => ownsCapture() ? repo.collections() : []).then((names) => { if (active && ownsCapture()) setCollections(names); }).catch(() => {});
    return () => { active = false; };
  }, [owner, userId]);
  async function save(value: ScrapbookDraft) {
    if (!owner || !ownsCapture() || submitting.current) return;
    submitting.current = true;
    setSaving(true); setError("");
    try {
      const repo = await scrapbookRepository(owner);
      if (!ownsCapture()) return;
      await repo.save(value);
      if (ownsCapture()) { onSaved?.(); onClose(); }
    } catch (reason) { if (ownsCapture()) setError(reason instanceof Error ? reason.message : "保存失败，请重试。"); }
    finally { submitting.current = false; if (ownsCapture()) setSaving(false); }
  }
  if (owner !== userId || invalidated.current) return null;
  if (!owner) return <div className="clipping-login"><p>登录后保存剪报。</p><Link to={`/account?returnTo=${encodeURIComponent(location.pathname + location.search + location.hash)}`}>登录</Link><button type="button" onClick={onClose}>取消</button></div>;
  return <ScrapbookEditor initial={initial} collections={collections} saving={saving} error={error} onSave={(value) => void save(value)} onClose={onClose} />;
}

export function ScrapbookButton({ source, quote = "", className, label = "加入剪报本" }: {
  source: ScrapbookSource; quote?: string; className?: string; label?: string;
}) {
  const userId = useAccountSessionStore((state) => state.userId);
  const location = useLocation();
  const [snapshot, setSnapshot] = useState<{ ownerId: string; source: ScrapbookSource; quote: string }>();
  const [savedOwner, setSavedOwner] = useState<string>();
  const saved = Boolean(userId) && savedOwner === userId;
  useLayoutEffect(() => { setSnapshot(undefined); setSavedOwner(undefined); }, [userId, source.contentUrl, quote]);
  if (!userId) return <Link className={className} to={`/account?returnTo=${encodeURIComponent(location.pathname + location.search + location.hash)}`}>{label}</Link>;
  return <>
    <button type="button" className={className} onPointerDown={(event) => event.preventDefault()} onClick={() => { setSavedOwner(undefined); setSnapshot({ ownerId: userId, source: { ...source }, quote: quote || window.getSelection()?.toString().trim() || "" }); }}>{saved ? "已加入剪报本" : label}</button>
    {saved && <span role="status" className="sr-only">已保存到剪报本</span>}
    {snapshot?.ownerId === userId && <ScrapbookCapture source={snapshot.source} quote={snapshot.quote} onClose={() => setSnapshot(undefined)} onSaved={() => { if (useAccountSessionStore.getState().userId === snapshot.ownerId) setSavedOwner(snapshot.ownerId); }} />}
  </>;
}
