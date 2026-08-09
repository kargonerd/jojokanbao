import DOMPurify from "dompurify";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { LoadingSpinner } from "@jojo/ui";
import type { JojoFragment, JojoTocNode } from "@jojo/content";
import {
  downloadExport,
  loadAssetUrl,
  loadFragment,
  loadItem,
  type LoadedItem,
} from "../content";

type ReaderTheme = "paper" | "light" | "dark";

function isReaderTheme(value: string): value is ReaderTheme {
  return value === "paper" || value === "light" || value === "dark";
}

function flattenToc(nodes: JojoTocNode[] = [], depth = 0): Array<JojoTocNode & { depth: number }> {
  return nodes.flatMap((node) => [
    ...(node.targetId ? [{ ...node, depth }] : []),
    ...flattenToc(node.children, depth + 1),
  ]);
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderedBody(fragment: JojoFragment, assetUrls: Record<string, string>): string {
  const source = fragment.body.format === "html"
    ? fragment.body.value
    : fragment.body.value.split(/\n{2,}/).map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br>")}</p>`).join("");
  const clean = DOMPurify.sanitize(source);
  const document = new DOMParser().parseFromString(`<main>${clean}</main>`, "text/html");
  for (const figure of document.querySelectorAll("figure[data-asset-id]")) {
    const assetId = figure.getAttribute("data-asset-id") || "";
    const url = assetUrls[assetId];
    if (!url) continue;
    const image = document.createElement("img");
    image.src = url;
    image.alt = figure.querySelector("figcaption")?.textContent || "正文图片";
    figure.prepend(image);
  }
  // Only internally generated Blob URLs are inserted after sanitization.
  return document.querySelector("main")?.innerHTML || "";
}

export function ReaderPage() {
  const { notebookId: datasetId, sourceId: itemKey } = useParams<{ notebookId: string; sourceId: string }>();
  const [loaded, setLoaded] = useState<LoadedItem>();
  const [fragment, setFragment] = useState<JojoFragment>();
  const [activeChapter, setActiveChapter] = useState("");
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [fontSize, setFontSize] = useState(17);
  const [theme, setTheme] = useState<ReaderTheme>("paper");

  useEffect(() => {
    if (!datasetId || !itemKey) return;
    setLoading(true); setError("");
    loadItem(datasetId, itemKey).then((value) => {
      setLoaded(value);
      setActiveChapter(value.manifest.content.chapters?.[0]?.id || "");
    }).catch((reason: Error) => setError(reason.message)).finally(() => setLoading(false));
  }, [datasetId, itemKey]);

  useEffect(() => {
    if (!loaded || !activeChapter) return;
    let cancelled = false;
    setFragment(undefined); setError("");
    loadFragment(loaded, activeChapter).then(async (value) => {
      const pairs = await Promise.all(value.assetRefs.map(async (assetId) => {
        try { return [assetId, await loadAssetUrl(loaded, assetId)] as const; }
        catch { return undefined; }
      }));
      if (cancelled) {
        pairs.forEach((pair) => pair && URL.revokeObjectURL(pair[1]));
        return;
      }
      setAssetUrls((previous) => {
        Object.values(previous).forEach((url) => URL.revokeObjectURL(url));
        return Object.fromEntries(pairs.filter((pair): pair is readonly [string, string] => Boolean(pair)));
      });
      setFragment(value);
    }).catch((reason: Error) => setError(reason.message));
    return () => { cancelled = true; };
  }, [activeChapter, loaded]);

  useEffect(() => () => Object.values(assetUrls).forEach((url) => URL.revokeObjectURL(url)), [assetUrls]);

  const toc = useMemo(() => flattenToc(loaded?.manifest.content.toc), [loaded]);
  const html = useMemo(() => fragment ? renderedBody(fragment, assetUrls) : "", [assetUrls, fragment]);
  if (loading) return <LoadingSpinner text="正在解码 Jox Manifest" fullscreen />;
  if (!loaded) return <div className="p-8 text-center text-muted">{error || "内容不存在"}</div>;
  const bgClass = theme === "dark" ? "bg-[#1a1a1a] text-[#e0e0e0]" : theme === "light" ? "bg-white text-ink" : "bg-paper-soft text-ink";

  return <div className="h-screen flex">
    <aside className="w-64 shrink-0 border-r border-rule overflow-y-auto bg-paper p-4 hidden md:block">
      <Link to="/rag/chat" className="text-xs font-bold text-red no-underline">← 返回问答</Link>
      <h2 className="text-base font-bold text-ink mt-4 mb-1">{loaded.manifest.title}</h2>
      <p className="text-xs text-muted mt-0 mb-4">{loaded.manifest.contentStats.chapterCount} 章 · {loaded.manifest.contentStats.characterCount.toLocaleString()} 字</p>
      <ul className="list-none m-0 p-0 space-y-0.5">
        {(toc.length ? toc : loaded.manifest.content.chapters?.map((chapter) => ({ ...chapter, targetId: chapter.id, depth: 0 })) || []).map((item) => (
          <li key={item.id}>
            <button onClick={() => item.targetId && setActiveChapter(item.targetId)} style={{ paddingLeft: `${8 + item.depth * 12}px` }} className={`block w-full text-left py-1.5 pr-2 text-xs border-0 bg-transparent ${activeChapter === item.targetId ? "text-red font-bold" : "text-ink hover:text-red"}`}>{item.title}</button>
          </li>
        ))}
      </ul>
    </aside>

    <div className={`flex-1 overflow-y-auto ${bgClass}`}>
      <div className="sticky top-0 z-10 flex items-center gap-4 px-6 py-2 border-b border-rule bg-paper/90 backdrop-blur-sm">
        <label className="text-xs text-muted flex items-center gap-1">字号 <input type="range" min="14" max="24" value={fontSize} onChange={(event) => setFontSize(+event.target.value)} className="w-16 accent-[var(--color-red)]" /></label>
        <select value={theme} onChange={(event) => { if (isReaderTheme(event.target.value)) setTheme(event.target.value); }} className="h-7 text-xs px-2">
          <option value="paper">纸张</option><option value="light">明亮</option><option value="dark">暗色</option>
        </select>
        {loaded.manifest.exports.some((item) => item.id === "export:epub") && <button className="ml-auto border-0 bg-transparent text-xs font-bold text-red cursor-pointer" onClick={() => void downloadExport(loaded, "export:epub").catch((reason: Error) => setError(reason.message))}>下载整本 EPUB</button>}
      </div>
      <article className="max-w-3xl mx-auto px-6 py-10" style={{ fontSize: `${fontSize}px`, lineHeight: 1.95 }}>
        {error && <p className="border-l-4 border-red bg-red/5 px-4 py-3 text-sm text-red">{error}</p>}
        {fragment ? <>
          <h1 className="text-3xl mb-8">{fragment.title}</h1>
          <div className="prose-editorial" dangerouslySetInnerHTML={{ __html: html }} />
          {fragment.annotations.length > 0 && <section className="mt-12 pt-6 border-t border-rule text-sm"><h2>注释</h2><ol>{fragment.annotations.map((note) => <li id={note.id} key={note.id} className="mb-3">{note.body.value}</li>)}</ol></section>}
          {fragment.assetRefs.flatMap((id) => {
            const asset = loaded.manifest.assets.find((candidate) => candidate.id === id);
            const url = assetUrls[id];
            if (!asset || !url || asset.type === "image") return [];
            if (asset.type === "audio") return [<audio key={id} controls className="w-full mt-5" src={url} />];
            if (asset.type === "video") return [<video key={id} controls className="w-full mt-5" src={url} />];
            return [];
          })}
        </> : <LoadingSpinner text="正在读取章节" />}
      </article>
    </div>
  </div>;
}
