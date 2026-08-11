import DOMPurify from "dompurify";
import { useEffect, useMemo, useRef, useState } from "react";
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
  const [fontSize, setFontSize] = useState(() => {
    const stored = Number(window.localStorage.getItem("jojo-reader-font-size"));
    return stored >= 14 && stored <= 24 ? stored : 17;
  });
  const [theme, setTheme] = useState<ReaderTheme>(() => {
    const stored = window.localStorage.getItem("jojo-reader-theme") || "";
    return isReaderTheme(stored) ? stored : "paper";
  });
  const [tocOpen, setTocOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [readingProgress, setReadingProgress] = useState(0);
  const readerRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (!fragment) return;
    readerRef.current?.scrollTo({ top: 0 });
    setReadingProgress(0);
  }, [fragment?.fragmentId]);

  useEffect(() => {
    const closePanels = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setTocOpen(false);
      setSettingsOpen(false);
    };
    window.addEventListener("keydown", closePanels);
    return () => window.removeEventListener("keydown", closePanels);
  }, []);

  useEffect(() => {
    window.localStorage.setItem("jojo-reader-font-size", String(fontSize));
  }, [fontSize]);

  useEffect(() => {
    window.localStorage.setItem("jojo-reader-theme", theme);
  }, [theme]);

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
  const chapters = loaded.manifest.content.chapters ?? [];
  const activeChapterIndex = Math.max(0, chapters.findIndex((chapter) => chapter.id === activeChapter));
  const tocItems = toc.length
    ? toc
    : chapters.map((chapter) => ({ ...chapter, targetId: chapter.id, depth: 0 }));
  const shellClass = theme === "dark" ? "bg-[#151716] text-[#deded8]" : theme === "light" ? "bg-[#e9ecec] text-ink" : "bg-[#e8e9e4] text-ink";
  const pageClass = theme === "dark" ? "bg-[#202321]" : theme === "light" ? "bg-white" : "bg-[#fbfaf6]";
  const panelClass = theme === "dark" ? "bg-[#242725] text-[#deded8] border-[#393d3a]" : "bg-[#fbfaf6] text-ink border-[#d8d8d1]";

  function chooseChapter(chapterId: string | undefined): void {
    if (!chapterId) return;
    setActiveChapter(chapterId);
    setTocOpen(false);
  }

  function updateProgress(): void {
    const reader = readerRef.current;
    if (!reader) return;
    const range = reader.scrollHeight - reader.clientHeight;
    setReadingProgress(range <= 0 ? 100 : Math.min(100, Math.round((reader.scrollTop / range) * 100)));
  }

  const controlClass = `w-12 h-12 border flex items-center justify-center bg-transparent cursor-pointer font-sans text-sm transition-colors focus-visible:outline-2 focus-visible:outline-red ${theme === "dark" ? "border-[#444844] hover:bg-[#2b2f2c]" : "border-[#d2d3ce] hover:bg-white"}`;

  return <div className={`h-screen overflow-hidden ${shellClass}`}>
    <nav aria-label="阅读工具" className="fixed left-5 top-1/2 z-30 hidden -translate-y-1/2 flex-col gap-2 md:flex">
      <Link to="/rag/chat" className={`${controlClass} no-underline text-current`} aria-label="返回问答" title="返回问答">←</Link>
      <button type="button" onClick={() => { setTocOpen(true); setSettingsOpen(false); }} className={controlClass} aria-label="打开目录" title="目录">目录</button>
      <button type="button" onClick={() => { setSettingsOpen((value) => !value); setTocOpen(false); }} className={controlClass} aria-label="阅读设置" title="阅读设置">Aa</button>
      <div className={`relative h-24 w-12 border ${theme === "dark" ? "border-[#444844]" : "border-[#d2d3ce]"}`} aria-label={`本章已读 ${readingProgress}%`} title={`本章已读 ${readingProgress}%`}>
        <div className="absolute inset-x-0 bottom-0 bg-red transition-[height] duration-200" style={{ height: `${readingProgress}%` }} />
        <span className="absolute inset-0 flex items-center justify-center font-sans text-[10px] [writing-mode:vertical-rl]">{readingProgress}%</span>
      </div>
    </nav>

    {tocOpen && <>
      <button type="button" aria-label="关闭目录" onClick={() => setTocOpen(false)} className="fixed inset-0 z-40 border-0 bg-black/20 cursor-default" />
      <aside className={`fixed inset-y-0 left-0 z-50 w-[min(88vw,390px)] overflow-y-auto border-r shadow-[18px_0_50px_rgba(0,0,0,.12)] ${panelClass}`}>
        <div className={`sticky top-0 z-10 border-b px-7 py-6 ${panelClass}`}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="m-0 font-sans text-[11px] tracking-[.22em] text-muted">目录</p>
              <h2 className="mt-2 mb-1 text-xl leading-snug">{loaded.manifest.title}</h2>
              <p className="m-0 font-sans text-xs text-muted">{chapters.length} 章 · {loaded.manifest.contentStats.characterCount.toLocaleString()} 字</p>
            </div>
            <button type="button" onClick={() => setTocOpen(false)} className="border-0 bg-transparent text-2xl cursor-pointer text-current" aria-label="关闭目录">×</button>
          </div>
        </div>
        <ol className="m-0 list-none px-4 py-5">
          {tocItems.map((item) => (
            <li key={item.id}>
              <button type="button" onClick={() => chooseChapter(item.targetId)} style={{ paddingLeft: `${16 + item.depth * 16}px` }} className={`relative block w-full border-0 bg-transparent py-2.5 pr-4 text-left font-serif text-[13px] leading-relaxed cursor-pointer ${activeChapter === item.targetId ? "font-bold text-red before:absolute before:inset-y-2 before:left-0 before:w-[2px] before:bg-red" : "text-current hover:text-red"}`}>{item.title}</button>
            </li>
          ))}
        </ol>
      </aside>
    </>}

    {settingsOpen && <>
      <button type="button" aria-label="关闭阅读设置" onClick={() => setSettingsOpen(false)} className="fixed inset-0 z-30 border-0 bg-black/10 cursor-default" />
      <section className={`fixed inset-x-4 bottom-4 z-40 border p-5 shadow-[8px_12px_35px_rgba(0,0,0,.14)] md:inset-x-auto md:bottom-auto md:left-20 md:top-1/2 md:w-72 md:-translate-y-1/2 ${panelClass}`} aria-label="阅读设置">
      <div className="mb-5 flex items-center justify-between"><h2 className="m-0 font-sans text-sm">阅读设置</h2><button type="button" onClick={() => setSettingsOpen(false)} className="border-0 bg-transparent text-xl cursor-pointer text-current" aria-label="关闭设置">×</button></div>
      <label className="mb-2 flex items-center justify-between font-sans text-xs text-muted"><span>字号</span><span>{fontSize}px</span></label>
      <input type="range" min="14" max="24" value={fontSize} onChange={(event) => setFontSize(+event.target.value)} className="mb-6 w-full accent-[var(--color-red)]" />
      <div className="mb-2 font-sans text-xs text-muted">纸张</div>
      <div className="grid grid-cols-3 gap-2">
        {(["paper", "light", "dark"] as ReaderTheme[]).map((value) => <button type="button" key={value} onClick={() => setTheme(value)} className={`h-10 border cursor-pointer ${value === "paper" ? "bg-[#fbfaf6] text-ink" : value === "light" ? "bg-white text-ink" : "bg-[#202321] text-white"} ${theme === value ? "border-red outline outline-1 outline-red" : "border-rule"}`}>{value === "paper" ? "纸张" : value === "light" ? "明亮" : "夜间"}</button>)}
      </div>
      {loaded.manifest.exports.some((item) => item.id === "export:epub") && <button type="button" className="mt-6 w-full border border-red bg-transparent py-2.5 font-sans text-xs font-bold text-red cursor-pointer hover:bg-red hover:text-white" onClick={() => void downloadExport(loaded, "export:epub").catch((reason: Error) => setError(reason.message))}>下载整本 EPUB</button>}
      </section>
    </>}

    <div ref={readerRef} onScroll={updateProgress} className="h-full overflow-y-auto scroll-smooth">
      <header className={`sticky top-0 z-20 border-b backdrop-blur-md ${theme === "dark" ? "border-[#303431] bg-[#151716]/90" : "border-[#d6d8d3] bg-[#e8e9e4]/90"}`}>
        <div className="mx-auto flex h-12 max-w-[920px] items-center gap-3 px-4 font-sans text-xs md:px-10">
          <Link to="/rag/chat" className="text-current no-underline md:hidden" aria-label="返回问答">←</Link>
          <button type="button" onClick={() => setTocOpen(true)} className="border-0 bg-transparent p-0 font-sans text-xs text-current cursor-pointer md:hidden">目录</button>
          <span className="min-w-0 flex-1 truncate text-muted">{loaded.manifest.title}</span>
          <span className="hidden max-w-[42%] truncate text-muted sm:block">{fragment?.title}</span>
          <button type="button" onClick={() => setSettingsOpen((value) => !value)} className="border-0 bg-transparent p-0 font-sans text-xs text-current cursor-pointer md:hidden">Aa</button>
          <span className="tabular-nums text-muted">{activeChapterIndex + 1}/{chapters.length}</span>
        </div>
      </header>

      <main className="mx-auto max-w-[920px] px-0 py-0 md:px-5 md:py-8">
        <article className={`relative min-h-[calc(100vh-96px)] border-x px-6 py-12 shadow-[0_16px_50px_rgba(32,32,28,.10)] sm:px-12 md:px-20 md:py-20 ${pageClass} ${theme === "dark" ? "border-[#2d312e]" : "border-[#ddddd6]"}`} style={{ fontSize: `${fontSize}px`, lineHeight: 2.05 }}>
          <div className="absolute inset-y-0 left-0 w-[3px] bg-red/10" aria-hidden="true"><div className="w-full bg-red transition-[height] duration-200" style={{ height: `${readingProgress}%` }} /></div>
          <div className="mx-auto max-w-[730px]">
            <p className="mb-5 mt-0 font-sans text-[11px] tracking-[.18em] text-muted">第 {activeChapterIndex + 1} / {chapters.length} 章</p>
        {error && <p className="border-l-4 border-red bg-red/5 px-4 py-3 text-sm text-red">{error}</p>}
        {fragment ? <>
          <h1 className="mb-12 mt-0 text-[2em] font-medium leading-[1.4] tracking-[-.02em]">{fragment.title}</h1>
          <div className="prose-editorial [&_p]:my-[1.15em] [&_p]:text-justify [&_p]:indent-[2em] [&_figure]:my-10 [&_figure_img]:mx-auto [&_figure_img]:block [&_figure_img]:max-h-[78vh] [&_figure_img]:max-w-full [&_figcaption]:mt-3 [&_figcaption]:text-center [&_figcaption]:font-sans [&_figcaption]:text-xs [&_figcaption]:text-muted" dangerouslySetInnerHTML={{ __html: html }} />
          {fragment.annotations.length > 0 && <section className="mt-16 border-t border-rule pt-8 text-[.82em] leading-[1.85]"><h2 className="mb-6 font-sans text-sm tracking-[.18em]">本章注释</h2><ol className="m-0 list-none p-0">{fragment.annotations.map((note: JojoAnnotation) => {
            const reference = parseAnnotationReference(note.body.value);
            return <li id={note.id} key={note.id} className="mb-4 scroll-mt-20 border-l border-rule pl-4 target:border-red target:bg-[rgba(139,26,26,.06)]">
              <span className="mr-2 font-bold text-red">{annotationDisplayLabel(note.label)}</span>
              <span>{note.body.value}</span>{" "}
              {reference && <button type="button" onClick={() => void followAnnotationReference(reference)} className="border-0 bg-transparent p-0 text-red font-bold cursor-pointer">跳转到原注</button>}{" "}
              <a href={`#${annotationMarkerId(note.id)}`} className="text-red no-underline" aria-label="返回正文脚注标记">↩</a>
            </li>;
          })}</ol></section>}
          {fragment.assetRefs.flatMap((id) => {
            const asset = loaded.manifest.assets.find((candidate) => candidate.id === id);
            const url = assetUrls[id];
            if (!asset || !url || asset.type === "image") return [];
            if (asset.type === "audio") return [<audio key={id} controls className="w-full mt-5" src={url} />];
            if (asset.type === "video") return [<video key={id} controls className="w-full mt-5" src={url} />];
            return [];
          })}
          <nav aria-label="章节导航" className="mt-20 grid grid-cols-2 border-t border-rule pt-8 font-sans text-xs">
            <button type="button" disabled={activeChapterIndex <= 0} onClick={() => chooseChapter(chapters[activeChapterIndex - 1]?.id)} className="border-0 bg-transparent py-4 pr-4 text-left text-current cursor-pointer disabled:cursor-default disabled:opacity-30"><span className="mb-1 block text-muted">上一章</span>{chapters[activeChapterIndex - 1]?.title ?? "已经是第一章"}</button>
            <button type="button" disabled={activeChapterIndex >= chapters.length - 1} onClick={() => chooseChapter(chapters[activeChapterIndex + 1]?.id)} className="border-0 border-l border-rule bg-transparent py-4 pl-4 text-right text-current cursor-pointer disabled:cursor-default disabled:opacity-30"><span className="mb-1 block text-muted">下一章</span>{chapters[activeChapterIndex + 1]?.title ?? "已经是最后一章"}</button>
          </nav>
        </> : <LoadingSpinner text="正在读取章节" />}
          </div>
        </article>
      </main>
    </div>
  </div>;
}
