import DOMPurify from "dompurify";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { LoadingSpinner } from "@jojo/ui";
import {
  JOJO_BOOK_SEARCH_BLOCK_SELECTOR,
  bookSearchBlockAnchorId,
  type JojoAnnotation,
  type JojoFragment,
  type JojoTocNode,
} from "@jojo/content";
import {
  downloadExport,
  loadAssetUrl,
  loadBookCoverUrl,
  loadFragment,
  loadItem,
  prefetchBookChapters,
  searchLoadedBook,
  type LoadedItem,
} from "../content";
import { readerReturnPathFromState, safeReaderReturnPath } from "../readerNavigation";
import { ReadingLoadingState } from "../../reading/ReadingLoadingState";
import { SpeechPlayer } from "../../reading/SpeechPlayer";
import { speechSegments } from "../../reading/speech";
import { BookReader } from "../components/BookReader";
import { useAccountSessionStore } from "../../account/session";
import { browserOfflineBookIdentity } from "../../offline/identity";
import { useOfflineBooksStore } from "../../offline/books";

export function flattenToc(nodes: JojoTocNode[] = [], depth = 0, inheritedTargetId?: string): Array<JojoTocNode & { depth: number }> {
  return nodes.flatMap((node) => {
    const targetId = node.targetId || inheritedTargetId;
    return [{ ...node, targetId, depth }, ...flattenToc(node.children, depth + 1, targetId)];
  });
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

function matchesChapterTitle(heading: Element | undefined, title: string): boolean {
  if (!heading || !/^H[1-6]$/.test(heading.tagName)) return false;
  const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/g, "");
  if (normalize(heading.textContent || "") === normalize(title)) return true;
  // Work on a detached copy: the displayed title keeps every note and anchor.
  const comparison = heading.cloneNode(true) as Element;
  for (const marker of comparison.querySelectorAll('a[href^="#"],a[data-target-id],a[data-anchor-id],[data-annotation-id],[role="doc-noteref"]')) {
    const text = normalize(marker.textContent || "");
    if (/^(?:\[\d+\]|〔\d+〕|【\d+】|\(\d+\)|[①-⑳*]+)$/.test(text)
      || (marker.tagName === "A" && /^\d+$/.test(text) && marker.querySelector("sup"))) marker.remove();
  }
  return normalize(comparison.textContent || "") === normalize(title);
}

export function renderedBody(fragment: JojoFragment, assetUrls: Record<string, string>): string {
  const source = fragment.body.format === "html"
    ? fragment.body.value
    : fragment.body.value.split(/\n{2,}/).map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br>")}</p>`).join("");
  const clean = DOMPurify.sanitize(source);
  const document = new DOMParser().parseFromString(`<main>${clean}</main>`, "text/html");
  const main = document.querySelector("main");
  let searchBlockNumber = 0;
  for (const element of document.querySelectorAll<HTMLElement>(JOJO_BOOK_SEARCH_BLOCK_SELECTOR)) {
    if (element.parentElement?.closest(JOJO_BOOK_SEARCH_BLOCK_SELECTOR)) continue;
    if (!element.textContent?.normalize("NFKC").replace(/\s+/g, " ").trim()) continue;
    searchBlockNumber += 1;
    if (!element.id) element.id = bookSearchBlockAnchorId(fragment.fragmentId, searchBlockNumber);
  }
  const firstContentElement = [...(main?.children ?? [])].find((element) => (
    element.tagName !== "HR"
    && (element.textContent?.replace(/\s+/g, "").length || element.querySelector("img,figure,svg"))
  ));
  if (/^H[1-6]$/.test(firstContentElement?.tagName ?? "")
    && !firstContentElement?.querySelector("a,sup,[data-annotation-id]")
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
  if (fragment.title.normalize("NFKC").trim() === "目录") {
    const selfEntry = [...(main?.children ?? [])].find((element) => (
      element.textContent?.normalize("NFKC").replace(/\s+/g, "").trim() === "目录"
    ));
    selfEntry?.remove();
  }
  for (const placeholder of document.querySelectorAll("figure[data-asset-id], span[data-asset-id]")) {
    const assetId = placeholder.getAttribute("data-asset-id") || "";
    const url = assetUrls[assetId];
    if (!url) continue;
    const image = document.createElement("img");
    image.src = url;
    if (placeholder.tagName === "SPAN") {
      image.alt = "行内图片";
      image.setAttribute("data-book-inline-asset", "true");
      placeholder.append(image);
      continue;
    }
    const role = placeholder.getAttribute("data-role");
    image.alt = placeholder.querySelector("figcaption")?.textContent
      || (role === "cover" ? "封面" : role === "table-image" ? "表格" : "正文图片");
    const width = Number(placeholder.getAttribute("data-width"));
    if (Number.isInteger(width) && width >= 10 && width <= 100) {
      (placeholder as HTMLElement).style.maxWidth = `${width}%`;
    }
    placeholder.prepend(image);
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
    link.className = "book-footnote-link text-red no-underline font-bold";
    marker.append(link);
    if (trailingText) marker.after(document.createTextNode(trailingText));
  }
  if (firstContentElement?.parentElement === main && matchesChapterTitle(firstContentElement, fragment.title)) {
    firstContentElement.classList.add("book-chapter-title");
  }
  // Only internally generated Blob URLs are inserted after sanitization.
  return main?.innerHTML || "";
}

export function shouldRenderChapterTitle(fragment: JojoFragment, html: string): boolean {
  const document = new DOMParser().parseFromString(`<main>${html}</main>`, "text/html");
  const main = document.querySelector("main");
  if (fragment.title !== "封面" && fragment.title !== "插图") {
    const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/g, "");
    const heading = [...(main?.children ?? [])].find((element) => element.tagName !== "HR"
      && (normalize(element.textContent || "") || element.querySelector("img,figure,svg")));
    return !matchesChapterTitle(heading, fragment.title);
  }
  return Boolean(main?.textContent?.replace(/\s+/g, "").length) || !main?.querySelector("img,figure,svg");
}

function BookChapterContent({ fragment, loaded, assetUrls, onAnnotationReference }: {
  fragment: JojoFragment;
  loaded: LoadedItem;
  assetUrls: Record<string, string>;
  onAnnotationReference: (reference: AnnotationReference) => void;
}) {
  const html = useMemo(() => renderedBody(fragment, assetUrls), [fragment, assetUrls]);
  return <>
    {shouldRenderChapterTitle(fragment, html) && <h1 className="book-chapter-title">{fragment.title}</h1>}
    <div className="prose-editorial [&_p]:my-[1.15em] [&_p]:text-justify [&_p]:indent-[2em] [&_h1]:text-red [&_h2]:text-red [&_h3]:text-red [&_h4]:text-red [&_figure]:my-10 [&_figure_img]:mx-auto [&_figure_img]:block [&_figure_img]:max-h-[78vh] [&_figure_img]:max-w-full [&_figcaption]:mt-3 [&_figcaption]:text-center [&_figcaption]:font-sans [&_figcaption]:text-xs [&_figcaption]:text-muted" dangerouslySetInnerHTML={{ __html: html }} />
    {fragment.annotations.length > 0 && <section className="mt-16 border-t border-rule pt-8 text-[.82em] leading-[1.85]"><h2 className="mb-6 font-sans text-sm tracking-[.18em]">本章注释</h2><ol className="m-0 list-none p-0">{fragment.annotations.map((note) => {
      const reference = parseAnnotationReference(note.body.value);
      return <li id={note.id} key={note.id} className="mb-4 scroll-mt-20 border-l border-rule pl-4 target:border-red target:bg-[rgba(139,26,26,.06)]">
        <span className="mr-2 font-bold text-red">{annotationDisplayLabel(note.label)}</span>
        <span>{note.body.value}</span>{" "}
        {reference && <button type="button" onClick={() => onAnnotationReference(reference)} className="border-0 bg-transparent p-0 text-red font-bold cursor-pointer">跳转到原注</button>}{" "}
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
  </>;
}

interface LoadedBookChapter {
  fragment: JojoFragment;
  content: ReactNode;
}

interface BookChapterSession {
  controller: AbortController;
  disposed: boolean;
  requests: Map<string, Promise<LoadedBookChapter>>;
  resolved: Map<string, LoadedBookChapter>;
  assets: Map<string, Promise<string>>;
  urls: Set<string>;
}

function waitForChapter<T>(request: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return request;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    request.then((value) => {
      signal.removeEventListener("abort", abort);
      if (!signal.aborted) resolve(value);
    }, (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

export function ReaderPage() {
  const { notebookId: datasetId, sourceId: itemKey } = useParams<{ notebookId: string; sourceId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const requestedChapter = searchParams.get("chapter") || "";
  const requestedAnnotation = searchParams.get("anchor") || searchParams.get("annotation") || "";
  const requestedQuote = searchParams.get("quote") || "";
  const requestedReturnTo = searchParams.get("returnTo");
  const readerReturnTo = safeReaderReturnPath(
    requestedReturnTo || readerReturnPathFromState(location.state),
  );
  const [loaded, setLoaded] = useState<LoadedItem>();
  const [loadedBookKey, setLoadedBookKey] = useState("");
  const [fragment, setFragment] = useState<JojoFragment>();
  const [activeChapter, setActiveChapter] = useState("");
  const [chapterContent, setChapterContent] = useState<ReactNode>();
  const [coverUrl, setCoverUrl] = useState("");
  const [focusText, setFocusText] = useState<{ text: string; token: number }>();
  const [focusAnchorId, setFocusAnchorId] = useState(requestedAnnotation);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const { initialized: authInitialized, userId } = useAccountSessionStore();
  const offlineIdentityVersion = useOfflineBooksStore((state) => state.identityVersion);
  const bookLoadKey = JSON.stringify([datasetId, itemKey, requestedAnnotation, requestedChapter, requestedQuote, authInitialized, userId, offlineIdentityVersion]);
  const offlineIdentity = browserOfflineBookIdentity();
  const readerUserId = loaded?.offline ? offlineIdentity.userId : userId;
  const readerIdentityReady = loaded?.offline ? offlineIdentity.initialized : authInitialized;
  const followReferenceRef = useRef<(reference: AnnotationReference) => Promise<void>>(undefined);
  const onAnnotationReference = useCallback((reference: AnnotationReference) => {
    void followReferenceRef.current?.(reference);
  }, []);
  const chapterSession = useMemo<BookChapterSession>(() => ({
    controller: new AbortController(), disposed: false,
    requests: new Map(), resolved: new Map(), assets: new Map(), urls: new Set(),
  }), [bookLoadKey, loaded, readerIdentityReady, readerUserId]);
  const latestChapterSession = useRef(chapterSession);
  latestChapterSession.current = chapterSession;

  useLayoutEffect(() => {
    chapterSession.disposed = false;
    if (chapterSession.controller.signal.aborted) chapterSession.controller = new AbortController();
    return () => {
      chapterSession.disposed = true;
      chapterSession.controller.abort();
      chapterSession.urls.forEach((url) => URL.revokeObjectURL(url));
      chapterSession.urls.clear();
      chapterSession.requests.clear();
      chapterSession.resolved.clear();
      chapterSession.assets.clear();
    };
  }, [chapterSession]);

  const loadChapterContent = useCallback(async (chapterId: string, signal?: AbortSignal): Promise<LoadedBookChapter> => {
    signal?.throwIfAborted();
    if (!loaded) throw new Error("书籍尚未载入");
    if (loadedBookKey !== bookLoadKey) throw new DOMException("阅读会话已变化", "AbortError");
    const access = loaded.manifest.access ?? loaded.item.access ?? loaded.index.access ?? loaded.entry.access ?? "public";
    if (access === "authenticated" && (!readerIdentityReady || !readerUserId || loaded.ownerId !== readerUserId)) {
      throw new Error("请登录后阅读这本书");
    }
    const controller = chapterSession.controller;
    const ensureCurrent = () => {
      controller.signal.throwIfAborted();
      if (chapterSession.disposed || latestChapterSession.current !== chapterSession) {
        throw new DOMException("阅读会话已变化", "AbortError");
      }
    };
    ensureCurrent();
    let request = chapterSession.requests.get(chapterId);
    if (!request) {
      request = (async () => {
        const value = await loadFragment(loaded, chapterId, controller.signal);
        ensureCurrent();
        let missingAsset = false;
        const pairs = await Promise.all(value.assetRefs.map(async (assetId) => {
          let asset = chapterSession.assets.get(assetId);
          if (!asset) {
            asset = loadAssetUrl(loaded, assetId, controller.signal).then((url) => {
              try { ensureCurrent(); }
              catch (reason) { URL.revokeObjectURL(url); throw reason; }
              chapterSession.urls.add(url);
              return url;
            });
            chapterSession.assets.set(assetId, asset);
            const pendingAsset = asset;
            void asset.catch(() => {
              if (chapterSession.assets.get(assetId) === pendingAsset) chapterSession.assets.delete(assetId);
            });
          }
          try { return [assetId, await asset] as const; }
          catch { ensureCurrent(); missingAsset = true; return undefined; }
        }));
        ensureCurrent();
        const assetUrls = Object.fromEntries(pairs.filter((pair): pair is readonly [string, string] => Boolean(pair)));
        const result = { fragment: value, content: <BookChapterContent fragment={value} loaded={loaded} assetUrls={assetUrls} onAnnotationReference={onAnnotationReference} /> };
        chapterSession.resolved.set(chapterId, result);
        // Keep text readable if an image fails, and allow the next request to retry it.
        if (missingAsset) chapterSession.requests.delete(chapterId);
        return result;
      })();
      chapterSession.requests.set(chapterId, request);
      const pendingRequest = request;
      void request.catch(() => {
        if (chapterSession.requests.get(chapterId) === pendingRequest) chapterSession.requests.delete(chapterId);
      });
    }
    return waitForChapter(request, signal);
  }, [bookLoadKey, chapterSession, loaded, loadedBookKey, onAnnotationReference, readerIdentityReady, readerUserId]);

  const loadChapter = useCallback(async (chapterId: string, signal: AbortSignal) => (
    await loadChapterContent(chapterId, signal)
  ).content, [loadChapterContent]);

  const activateChapter = useCallback((chapterId: string) => {
    const cached = chapterSession.resolved.get(chapterId);
    setFragment(cached?.fragment);
    setChapterContent(cached?.content);
    setActiveChapter(chapterId);
  }, [chapterSession]);

  const onVisibleChapterChange = useCallback((chapterId: string) => {
    const cached = chapterSession.resolved.get(chapterId);
    if (!cached || chapterSession.disposed) return;
    setFocusText(undefined);
    setFocusAnchorId("");
    setFragment(cached.fragment);
    setChapterContent(cached.content);
    setActiveChapter(chapterId);
  }, [chapterSession]);

  useEffect(() => {
    if (!datasetId || !itemKey) return;
    let active = true;
    setLoaded(undefined); setFragment(undefined); setChapterContent(undefined);
    setLoading(true); setError("");
    loadItem(datasetId, itemKey).then((value) => {
      if (!active) return;
      setLoaded(value);
      setLoadedBookKey(bookLoadKey);
      const requested = value.manifest.content.chapters?.find((chapter) => chapter.id === requestedChapter);
      setFocusAnchorId(requestedAnnotation);
      const normalizedQuote = requestedQuote
        .replace(/^…+|…+$/g, "")
        .replace(/\s+/g, " ")
        .trim();
      setFocusText(normalizedQuote
        ? { text: normalizedQuote.slice(0, 80), token: Date.now() }
        : undefined);
      setActiveChapter(requested?.id || value.manifest.content.chapters?.[0]?.id || "");
    }).catch((reason: Error) => { if (active) setError(reason.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [bookLoadKey, datasetId, itemKey, requestedAnnotation, requestedChapter, requestedQuote]);

  useEffect(() => {
    if (!datasetId || !itemKey) return;
    let active = true;
    setCoverUrl("");
    void loadBookCoverUrl(datasetId, itemKey).then((url) => {
      if (active && url) setCoverUrl(url);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [datasetId, itemKey, userId]);

  useEffect(() => {
    if (!loaded || !activeChapter || loadedBookKey !== bookLoadKey) return;
    const access = loaded.manifest.access ?? loaded.item.access ?? loaded.index.access ?? loaded.entry.access ?? "public";
    if (access === "authenticated" && (!readerIdentityReady || !readerUserId || loaded.ownerId !== readerUserId)) return;
    let cancelled = false;
    const controller = new AbortController();
    setError("");
    const cached = chapterSession.resolved.get(activeChapter);
    if (cached) {
      setFragment(cached.fragment); setChapterContent(cached.content);
      return;
    }
    setFragment(undefined); setChapterContent(undefined);
    loadChapterContent(activeChapter, controller.signal).then((value) => {
      if (cancelled) return;
      setFragment(value.fragment); setChapterContent(value.content);
    }).catch((reason: Error) => { if (!cancelled) setError(reason.message); });
    return () => { cancelled = true; controller.abort(); };
  }, [activeChapter, bookLoadKey, chapterSession, loaded, loadedBookKey, loadChapterContent, readerIdentityReady, readerUserId]);

  useEffect(() => {
    if (!loaded || !fragment) return;
    const controller = new AbortController();
    void prefetchBookChapters(loaded, fragment.fragmentId, controller.signal);
    return () => controller.abort();
  }, [loaded, fragment]);

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
      if (requestedReturnTo) query.set("returnTo", readerReturnTo);
      navigate(`/book/${encodeURIComponent(datasetId)}/${encodeURIComponent(targetSummary.itemKey)}?${query}`, {
        state: location.state,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  followReferenceRef.current = followAnnotationReference;

  const toc = useMemo(() => flattenToc(loaded?.manifest.content.toc), [loaded]);
  const spokenChapter = useMemo(() => fragment
    ? speechSegments(fragment.title, fragment.body.value, fragment.body.format)
    : [], [fragment]);
  if (loading || (loaded && loadedBookKey !== bookLoadKey)) return <ReadingLoadingState kind="book" status="正在打开书籍" fullscreen />;
  if (!loaded) return <div className="p-8 text-center text-muted">{error || "内容不存在"}</div>;
  const access = loaded.manifest.access ?? loaded.item.access ?? loaded.index.access ?? loaded.entry.access ?? "public";
  if (access === "authenticated" && (!readerIdentityReady || !readerUserId)) {
    if (!readerIdentityReady) return <LoadingSpinner text="正在确认登录状态" fullscreen />;
    const returnTo = `${window.location.pathname}${window.location.search}`;
    return <main className="flex min-h-screen items-center justify-center bg-paper px-6 text-center"><div className="max-w-md border-l-2 border-red pl-6 text-left"><p className="m-0 text-xs tracking-[.18em] text-red">登录后阅读</p><h1 className="my-4 text-2xl">{loaded.manifest.title}</h1><p className="text-sm leading-7 text-muted">这本书需要登录后阅读。登录后会回到这里。</p><Link className="text-sm font-bold text-red no-underline" to={`/account?returnTo=${encodeURIComponent(returnTo)}`}>登录 / 注册 →</Link></div></main>;
  }
  const chapters = loaded.manifest.content.chapters ?? [];
  const activeChapterIndex = Math.max(0, chapters.findIndex((chapter) => chapter.id === activeChapter));
  const representedChapters = new Set(toc.map((item) => item.targetId));
  const tocItems = [...toc, ...chapters.filter((chapter) => !representedChapters.has(chapter.id))
    .map((chapter) => ({ ...chapter, targetId: chapter.id, depth: 0 }))];
  const logicalChapterCount = (loaded.manifest.content.toc ?? []).filter((item) => (
    /^第[〇零一二两三四五六七八九十百\d]+章(?:[：:]|$)/.test(item.title.trim())
  )).length || undefined;
  return <BookReader
    bookTitle={loaded.manifest.title}
    datasetId={loaded.manifest.datasetId}
    itemId={loaded.manifest.itemId}
    itemKey={loaded.item.itemKey}
    manifestObject={loaded.manifestObject}
    characterCount={loaded.manifest.contentStats.characterCount}
    logicalChapterCount={logicalChapterCount}
    chapters={chapters.map((chapter) => ({ id: chapter.id, title: chapter.title, characterCount: chapter.characterCount }))}
    toc={tocItems.map((item) => ({ id: item.id, title: item.title, targetId: item.targetId, anchorId: "anchorId" in item ? item.anchorId : undefined, depth: item.depth }))}
    activeChapterId={activeChapter}
    chapterKey={fragment?.fragmentId ?? activeChapter}
    focusAnchorId={focusAnchorId || undefined}
    focusText={focusText}
    contentLoading={!fragment}
    error={error}
    backHref={readerReturnTo}
    loadChapter={loadChapter}
    onVisibleChapterChange={onVisibleChapterChange}
    onChapterChange={(chapterId) => {
      setFocusText(undefined);
      setFocusAnchorId("");
      activateChapter(chapterId);
    }}
    onLocate={(chapterId, text) => {
      const normalizedText = text?.replace(/\s+/g, " ").trim();
      setFocusText(normalizedText ? { text: normalizedText.length > 80 ? normalizedText.slice(0, 36) : normalizedText, token: Date.now() } : undefined);
      activateChapter(chapterId);
    }}
    onInternalLink={(chapterId, anchorId) => {
      setFocusText(undefined);
      setFocusAnchorId(anchorId || "");
      activateChapter(chapterId);
    }}
    onSearch={(query) => searchLoadedBook(loaded, query)}
    speechControl={<SpeechPlayer
      contentId={`book:${loaded.manifest.datasetId}:${loaded.item.itemKey}`}
      segments={spokenChapter}
      label="听本章"
      title={fragment?.title || chapters[activeChapterIndex]?.title}
      collectionTitle={loaded.manifest.title}
      artworkUrl={coverUrl || undefined}
      queueItems={chapters.map((chapter) => ({ id: chapter.id, title: chapter.title }))}
      activeQueueId={activeChapter}
      loadQueueItem={async (chapterId) => {
        const { fragment: chapter } = await loadChapterContent(chapterId);
        return { title: chapter.title, segments: speechSegments(chapter.title, chapter.body.value, chapter.body.format) };
      }}
      onQueueItemChange={(chapterId) => {
        setFocusText(undefined);
        setFocusAnchorId("");
        activateChapter(chapterId);
      }}
    />}
    onDownload={loaded.manifest.exports.some((item) => item.id === "export:epub")
      ? () => void downloadExport(loaded, "export:epub").catch((reason: Error) => setError(reason.message))
      : undefined}
  >
    {chapterContent ?? <ReadingLoadingState kind="book" status="正在读取章节" spacingClassName="py-12" className="mx-auto max-w-sm" />}
  </BookReader>;
}
