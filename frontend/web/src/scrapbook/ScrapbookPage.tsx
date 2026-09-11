import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { withSearchLocation } from "@jojo/content";
import { SCRAPBOOK_PAGE_SIZE, safeScrapbookPath, scrapbookMarkdown, type ScrapbookDraft, type ScrapbookEntry } from "@jojo/auth";
import { useAccountSessionStore } from "../account/session";
import { scrapbookRepository } from "./api";
import { ScrapbookEditor } from "./ScrapbookEditor";
import "./scrapbook.css";

function clippingSourceHref(entry: ScrapbookEntry): string | undefined {
  const path = safeScrapbookPath(entry.contentUrl);
  if (!path) return undefined;
  const url = new URL(path, "https://reader.jojokanbao.cn");
  return withSearchLocation(path, { query: "", quote: url.searchParams.get("quote") || entry.quote.slice(0, 160), returnTo: "/scrapbook" });
}

export function ScrapbookPage() {
  const userId = useAccountSessionStore((state) => state.userId);
  const initialized = useAccountSessionStore((state) => state.initialized);
  const [entries, setEntries] = useState<ScrapbookEntry[]>([]);
  const [collections, setCollections] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [collection, setCollection] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<ScrapbookEntry>();
  const [deleting, setDeleting] = useState<string>();
  const generation = useRef(0);
  const reload = useCallback(async (append = false) => {
    const owner = userId;
    if (!owner) return;
    const request = ++generation.current;
    setLoading(true); setError("");
    try {
      const repo = await scrapbookRepository();
      const [page, names] = await Promise.all([repo.list(search, collection, append ? entries.length : 0), repo.collections()]);
      if (generation.current !== request || useAccountSessionStore.getState().userId !== owner) return;
      setEntries((current) => append ? [...current, ...page.filter((item) => !current.some((old) => old.id === item.id))] : page);
      setCollections(names); setHasMore(page.length === SCRAPBOOK_PAGE_SIZE);
    } catch (reason) {
      if (generation.current === request && useAccountSessionStore.getState().userId === owner) setError(reason instanceof Error ? reason.message : "剪报本加载失败。");
    } finally { if (generation.current === request) setLoading(false); }
  }, [userId, search, collection, entries.length]);
  const reloadLatest = useRef(reload);
  reloadLatest.current = reload;
  useLayoutEffect(() => { setBusy(false); setEntries([]); setCollections([]); setEditing(undefined); setQuery(""); setSearch(""); setCollection(null); }, [userId]);
  useEffect(() => {
    ++generation.current; setEntries([]); setCollections([]); setEditing(undefined); setDeleting(undefined); setError(""); setLoading(false);
    if (userId) void reload();
    return () => { ++generation.current; };
    // A page append must not restart the initial request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, search, collection]);
  async function save(draft: ScrapbookDraft) {
    const owner = userId;
    if (!editing || !owner) return;
    setBusy(true); setError("");
    try {
      await (await scrapbookRepository()).save(draft, editing.id);
      if (useAccountSessionStore.getState().userId === owner) { setEditing(undefined); await reloadLatest.current(); }
    } catch (reason) { if (useAccountSessionStore.getState().userId === owner) setError(reason instanceof Error ? reason.message : "保存失败。"); }
    finally { if (useAccountSessionStore.getState().userId === owner) setBusy(false); }
  }
  async function remove(id: string) {
    const owner = userId; setBusy(true); setError("");
    try {
      await (await scrapbookRepository()).remove(id);
      if (useAccountSessionStore.getState().userId === owner) { setDeleting(undefined); await reloadLatest.current(); }
    } catch { if (useAccountSessionStore.getState().userId === owner) setError("删除失败，请重试。"); }
    finally { if (useAccountSessionStore.getState().userId === owner) setBusy(false); }
  }
  async function exportClippings() {
    const owner = userId; setBusy(true); setError("");
    try {
      const repo = await scrapbookRepository();
      const all: ScrapbookEntry[] = [];
      for (let offset = 0; ; offset += SCRAPBOOK_PAGE_SIZE) {
        const page = await repo.list(search, collection, offset);
        if (useAccountSessionStore.getState().userId !== owner) return;
        all.push(...page);
        if (page.length < SCRAPBOOK_PAGE_SIZE) break;
      }
      const url = URL.createObjectURL(new Blob([scrapbookMarkdown(all)], { type: "text/markdown;charset=utf-8" }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = "JOJO-剪报本.md"; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { if (useAccountSessionStore.getState().userId === owner) setError("导出失败，请检查网络后重试。"); }
    finally { if (useAccountSessionStore.getState().userId === owner) setBusy(false); }
  }
  function submit(event: FormEvent) { event.preventDefault(); setSearch(query.trim()); }
  return <main className="scrapbook-page">
    <header className="scrapbook-heading"><div><h1>剪报本</h1><p>摘录、笔记与它们的原文出处。</p></div>{userId && <button type="button" disabled={busy || loading || !entries.length} onClick={() => void exportClippings()}>导出 Markdown</button>}</header>
    {!initialized ? <p role="status">正在读取账号…</p> : !userId ? <section className="scrapbook-empty"><h2>登录后保存你的剪报</h2><p>阅读时选中文字，或从阅读器的更多菜单中加入剪报本。</p><Link to="/account?returnTo=%2Fscrapbook">登录</Link></section> : <>
      <form className="scrapbook-filters" onSubmit={submit}><label className="sr-only" htmlFor="clipping-search">搜索剪报</label><input id="clipping-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索摘录、笔记和书名" /><button type="submit">搜索</button><label><span className="sr-only">筛选专题</span><select value={JSON.stringify(collection)} onChange={(event) => setCollection(JSON.parse(event.target.value) as string | null)}><option value="null">全部专题</option><option value={JSON.stringify("")}>未分类</option>{collections.map((name) => <option key={name} value={JSON.stringify(name)}>{name}</option>)}</select></label></form>
      {error && <p role="alert" className="clipping-error">{error} <button type="button" disabled={loading} onClick={() => void reload()}>重试</button></p>}
      {loading && <p role="status">正在读取剪报…</p>}
      {!loading && !error && !entries.length && <section className="scrapbook-empty"><h2>{search || collection !== null ? "没有符合条件的剪报" : "从一段值得留下的原文开始"}</h2><p>在报刊或书籍阅读页选择“加入剪报本”，摘录和出处会一起保存。</p><Link to="/library">去资料库阅读</Link></section>}
      <section className="scrapbook-list" aria-label="我的剪报">{entries.map((entry) => <article key={entry.id} className="clipping-card">
        <header><h2>{entry.contentTitle}</h2>{entry.collection && <span className="clipping-collection">{entry.collection}</span>}</header>
        <p className="clipping-source">{entry.locationLabel}　{new Date(entry.createdAt).toLocaleDateString("zh-CN")}</p>
        {entry.quote && <blockquote>{entry.quote}</blockquote>}{entry.note && <p className="clipping-note">{entry.note}</p>}
        <footer>{clippingSourceHref(entry) && <Link to={clippingSourceHref(entry)!}>返回原文</Link>}<button disabled={busy} type="button" onClick={() => { setError(""); setEditing(entry); }}>编辑</button>{deleting === entry.id ? <><span>删除这条剪报？</span><button disabled={busy} type="button" onClick={() => void remove(entry.id)}>确认删除</button><button type="button" disabled={busy} onClick={() => setDeleting(undefined)}>取消</button></> : <button type="button" disabled={busy} onClick={() => setDeleting(entry.id)}>删除</button>}</footer>
      </article>)}</section>
      {hasMore && <button type="button" disabled={loading} onClick={() => void reload(true)}>加载更多</button>}
      {editing && <ScrapbookEditor initial={editing} collections={collections} saving={busy} error={error} onSave={(value) => void save(value)} onClose={() => setEditing(undefined)} />}
    </>}
  </main>;
}
