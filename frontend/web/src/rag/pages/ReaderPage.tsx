import DOMPurify from "dompurify";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { LoadingSpinner } from "@jojo/ui";
import type { JojoAnnotation, JojoFragment, JojoTocNode } from "@jojo/content";
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

const CHINESE_DIGITS: Record<string, number> = {
  "〇": 0, "零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
  "五": 5, "六": 6, "七": 7, "八": 8, "九": 9,
};

function chineseNumber(value: string): number | undefined {
  if (/^\d+$/.test(value)) return Number(value);
  if (value === "十") return 10;
  if (value.includes("十")) {
    const [tens, units] = value.split("十", 2);
    const high = tens ? CHINESE_DIGITS[tens] : 1;
    const low = units ? CHINESE_DIGITS[units] : 0;
    return high === undefined || low === undefined ? undefined : high * 10 + low;
  }
  if ([...value].every((character) => character in CHINESE_DIGITS)) {
    return Number([...value].map((character) => CHINESE_DIGITS[character]).join(""));
  }
  return undefined;
}

export interface AnnotationReference {
  volumeNumber: number;
  chapterTitle: string;
  annotationLabel: string;
}

export function parseAnnotationReference(value: string): AnnotationReference | undefined {
  const match = value.match(/(?:见|参见)本书第([〇零一二两三四五六七八九十\d]+)卷《([^》]+)》注[〔\[]\s*(\d+)\s*[〕\]]/);
  if (!match) return undefined;
  const volumeNumber = chineseNumber(match[1]!);
  if (!volumeNumber) return undefined;
  return { volumeNumber, chapterTitle: match[2]!.trim(), annotationLabel: match[3]! };
}

function annotationMarkerId(annotationId: string): string {
  return `annotation-ref-${annotationId}`;
}

function annotationDisplayLabel(label: string | undefined): string {
  if (!label) return "注";
  return /^\*+$/.test(label) ? label : `[${label}]`;
}

export function findReferencedAnnotation(
  fragment: JojoFragment,
  label: string,
  anchorId?: string,
): JojoAnnotation | undefined {
  if (!/^\d+$/.test(label)) {
    return fragment.annotations.find((annotation) => annotation.label === label);
  }
  const clean = DOMPurify.sanitize(fragment.body.value);
  const document = new DOMParser().parseFromString(`<main>${clean}</main>`, "text/html");
  const elements = [...document.querySelectorAll("main *")];
  const anchor = anchorId ? document.getElementById(anchorId) : undefined;
  const anchorIndex = anchor ? elements.indexOf(anchor) : -1;
  const anchorHeadingLevel = anchor?.tagName.match(/^H([1-6])$/)?.[1];
  let endIndex = elements.length;
  if (anchorIndex >= 0 && anchorHeadingLevel) {
    const level = Number(anchorHeadingLevel);
    const nextHeadingOffset = elements.slice(anchorIndex + 1).findIndex((element) => {
      const match = element.tagName.match(/^H([1-6])$/);
      return Boolean(match && Number(match[1]) <= level);
    });
    if (nextHeadingOffset >= 0) endIndex = anchorIndex + 1 + nextHeadingOffset;
  }
  const annotations = new Map(fragment.annotations.map((annotation) => [annotation.id, annotation]));
  const numbered = elements
    .map((element, index) => ({ element, index }))
    .filter(({ element, index }) => (
      element.matches("sup[data-annotation-id]")
      && !element.closest("h1,h2,h3,h4,h5,h6")
      && (anchorIndex < 0 || (index > anchorIndex && index < endIndex))
    ))
    .map(({ element }) => annotations.get(element.getAttribute("data-annotation-id") || ""))
    .filter((annotation): annotation is JojoAnnotation => Boolean(annotation));
  return numbered[Number(label) - 1]
    ?? fragment.annotations.find((annotation) => annotation.label === label);
}

export function renderedBody(fragment: JojoFragment, assetUrls: Record<string, string>): string {
  const source = fragment.body.format === "html"
    ? fragment.body.value
    : fragment.body.value.split(/\n{2,}/).map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br>")}</p>`).join("");
  const clean = DOMPurify.sanitize(source);
  const document = new DOMParser().parseFromString(`<main>${clean}</main>`, "text/html");
  const main = document.querySelector("main");
  const firstContentElement = [...(main?.children ?? [])].find((element) => element.tagName !== "HR");
  if (/^H[1-6]$/.test(firstContentElement?.tagName ?? "")
    && firstContentElement?.textContent?.normalize("NFKC").replace(/\s+/g, " ").trim()
      === fragment.title.normalize("NFKC").replace(/\s+/g, " ").trim()) {
    const headingId = firstContentElement.id;
    if (headingId) {
      const anchor = document.createElement("span");
      anchor.id = headingId;
      firstContentElement.before(anchor);
    }
    firstContentElement.remove();
  }
  for (const figure of document.querySelectorAll("figure[data-asset-id]")) {
    const assetId = figure.getAttribute("data-asset-id") || "";
    const url = assetUrls[assetId];
    if (!url) continue;
    const image = document.createElement("img");
    image.src = url;
    image.alt = figure.querySelector("figcaption")?.textContent || "正文图片";
    figure.prepend(image);
  }
  const annotations = new Map(fragment.annotations.map((annotation) => [annotation.id, annotation]));
  for (const marker of document.querySelectorAll("sup[data-annotation-id]")) {
    const annotationId = marker.getAttribute("data-annotation-id") || "";
    const annotation = annotations.get(annotationId);
    if (!annotation) continue;
    const trailingText = marker.textContent || "";
    marker.id = annotationMarkerId(annotationId);
    marker.textContent = "";
    const link = document.createElement("a");
    link.href = `#${annotationId}`;
    link.textContent = annotationDisplayLabel(annotation.label);
    link.title = annotation.body.value;
    link.setAttribute("aria-label", `查看注释 ${annotation.label || "注"}`);
    link.className = "text-red no-underline font-bold";
    marker.append(link);
    if (trailingText) marker.after(document.createTextNode(trailingText));
  }
  // Only internally generated Blob URLs are inserted after sanitization.
  return main?.innerHTML || "";
}

export function ReaderPage() {
  const { notebookId: datasetId, sourceId: itemKey } = useParams<{ notebookId: string; sourceId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedChapter = searchParams.get("chapter") || "";
  const requestedAnnotation = searchParams.get("annotation") || "";
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
      const requested = value.manifest.content.chapters?.find((chapter) => chapter.id === requestedChapter);
      setActiveChapter(requested?.id || value.manifest.content.chapters?.[0]?.id || "");
    }).catch((reason: Error) => setError(reason.message)).finally(() => setLoading(false));
  }, [datasetId, itemKey, requestedChapter]);

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

  useEffect(() => {
    if (!fragment || !requestedAnnotation) return;
    if (!fragment.annotations.some((annotation) => annotation.id === requestedAnnotation)) return;
    window.requestAnimationFrame(() => {
      document.getElementById(requestedAnnotation)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [fragment, requestedAnnotation]);

  async function followAnnotationReference(reference: AnnotationReference): Promise<void> {
    if (!loaded || !datasetId) return;
    setError("");
    try {
      const targetSummary = loaded.index.items.find((item) => (
        item.itemKey === `volume-${reference.volumeNumber}` || item.order === reference.volumeNumber
      ));
      if (!targetSummary) throw new Error(`找不到第${reference.volumeNumber}卷`);
      const target = await loadItem(datasetId, targetSummary.itemKey);
      const targetTocNode = flattenToc(target.manifest.content.toc).find((node) => (
        node.title.normalize("NFKC").trim() === reference.chapterTitle.normalize("NFKC").trim()
      ));
      const targetChapter = target.manifest.content.chapters?.find((chapter) => (
        chapter.id === targetTocNode?.targetId ||
        chapter.title.normalize("NFKC").trim() === reference.chapterTitle.normalize("NFKC").trim()
      ));
      if (!targetChapter) throw new Error(`找不到《${reference.chapterTitle}》`);
      const targetFragment = await loadFragment(target, targetChapter.id);
      const targetAnnotation = findReferencedAnnotation(
        targetFragment,
        reference.annotationLabel,
        targetTocNode?.anchorId,
      );
      if (!targetAnnotation) throw new Error(`《${reference.chapterTitle}》没有注〔${reference.annotationLabel}〕`);
      const query = new URLSearchParams({
        chapter: targetChapter.id,
        annotation: targetAnnotation.id,
      });
      navigate(`/rag/source/${encodeURIComponent(datasetId)}/${encodeURIComponent(targetSummary.itemKey)}?${query}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

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
          {fragment.annotations.length > 0 && <section className="mt-12 pt-6 border-t border-rule text-sm"><h2>注释</h2><ul className="list-none p-0">{fragment.annotations.map((note: JojoAnnotation) => {
            const reference = parseAnnotationReference(note.body.value);
            return <li id={note.id} key={note.id} className="mb-3 scroll-mt-20 target:bg-[rgba(139,26,26,.08)]">
              <span className="mr-2 font-bold text-red">{annotationDisplayLabel(note.label)}</span>
              <span>{note.body.value}</span>{" "}
              {reference && <button type="button" onClick={() => void followAnnotationReference(reference)} className="border-0 bg-transparent p-0 text-red font-bold cursor-pointer">跳转到原注</button>}{" "}
              <a href={`#${annotationMarkerId(note.id)}`} className="text-red no-underline" aria-label="返回正文脚注标记">↩</a>
            </li>;
          })}</ul></section>}
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
