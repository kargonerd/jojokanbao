import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

export interface ContinuousBookContentHandle {
  seek: (chapterId: string, progress?: number) => void;
  getChapterRoot: (chapterId: string) => HTMLElement | null;
}

interface Props {
  chapters: Array<{ id: string; title: string }>;
  initialChapterId: string;
  loadChapter: (chapterId: string, signal: AbortSignal) => Promise<ReactNode>;
  scrollRef: RefObject<HTMLDivElement | null>;
  onPosition: (chapterId: string, progress: number) => void;
  onReady: () => void;
}

type Entry = { id: string; index: number; content: ReactNode };
type Anchor = { element: HTMLElement; offset: number };

/** Keep chapter DOM in reading order; extending either edge never replaces it. */
export const ContinuousBookContent = forwardRef<ContinuousBookContentHandle, Props>(function ContinuousBookContent(props, ref) {
  const latest = useRef(props);
  latest.current = props;
  const container = useRef<HTMLDivElement>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const [errors, setErrors] = useState<Record<string, string>>({});
  const errorsRef = useRef(errors);
  errorsRef.current = errors;
  const [loading, setLoading] = useState(0);
  const requests = useRef(new Map<string, AbortController>());
  const generation = useRef(0);
  const anchor = useRef<Anchor | null>(null);
  const pendingSeek = useRef<{ id: string; progress: number } | null>(null);
  const mounted = useRef(true);
  const frame = useRef<number | undefined>(undefined);
  const inspectRef = useRef<() => void>(() => {});

  const getChapterRoot = useCallback((id: string) => {
    return Array.from(container.current?.querySelectorAll<HTMLElement>("[data-book-chapter-id]") ?? [])
      .find((element) => element.dataset.bookChapterId === id) ?? null;
  }, []);

  const captureAnchor = useCallback(() => {
    const scroll = latest.current.scrollRef.current;
    if (!scroll) return;
    const top = scroll.getBoundingClientRect().top;
    const sections = Array.from(container.current?.querySelectorAll<HTMLElement>("[data-book-chapter-id]") ?? []);
    const section = sections.find((element) => element.getBoundingClientRect().bottom > top + 1);
    if (!section) return;
    const element = Array.from(section.querySelectorAll<HTMLElement>("h1,h2,h3,h4,p,li,figure,table"))
      .find((candidate) => candidate.getBoundingClientRect().bottom > top + 1) ?? section;
    anchor.current = { element, offset: element.getBoundingClientRect().top - top };
  }, []);

  const restoreAnchor = useCallback(() => {
    const scroll = latest.current.scrollRef.current;
    const saved = anchor.current;
    if (!scroll || !saved?.element.isConnected) return;
    const difference = saved.element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - saved.offset;
    if (Math.abs(difference) > .5) scroll.scrollTop += difference;
  }, []);

  const requestChapter = useCallback((index: number) => {
    const chapter = latest.current.chapters[index];
    if (!chapter || requests.current.has(chapter.id) || entriesRef.current.some((entry) => entry.id === chapter.id)) return;
    const controller = new AbortController();
    const epoch = generation.current;
    requests.current.set(chapter.id, controller);
    setLoading((value) => value + 1);
    void latest.current.loadChapter(chapter.id, controller.signal).then((content) => {
      if (!mounted.current || controller.signal.aborted || epoch !== generation.current) return;
      captureAnchor();
      setEntries((previous) => previous.some((entry) => entry.id === chapter.id) ? previous
        : [...previous, { id: chapter.id, index, content }].sort((a, b) => a.index - b.index));
      setErrors((previous) => { const next = { ...previous }; delete next[chapter.id]; return next; });
    }).catch(() => {
      if (mounted.current && !controller.signal.aborted && epoch === generation.current) {
        setErrors((previous) => ({ ...previous, [chapter.id]: `“${chapter.title}”暂时无法加载` }));
      }
    }).finally(() => {
      if (requests.current.get(chapter.id) === controller) requests.current.delete(chapter.id);
      if (mounted.current && epoch === generation.current) setLoading((value) => Math.max(0, value - 1));
    });
  }, [captureAnchor]);

  const seek = useCallback((id: string, progress = 0) => {
    const index = latest.current.chapters.findIndex((chapter) => chapter.id === id);
    if (index < 0) return;
    pendingSeek.current = { id, progress: Math.max(0, Math.min(100, progress)) };
    const existing = getChapterRoot(id);
    if (existing) {
      const scroll = latest.current.scrollRef.current;
      if (scroll) {
        const offset = existing.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
        scroll.scrollTop = Math.max(0, offset + existing.offsetHeight * pendingSeek.current.progress / 100 - 60);
        pendingSeek.current = null;
        captureAnchor();
        inspectRef.current();
        latest.current.onReady();
      }
      return;
    }
    // A deliberate jump starts a new contiguous window. Normal scrolling never evicts chapters.
    generation.current += 1;
    for (const controller of requests.current.values()) controller.abort();
    requests.current.clear();
    entriesRef.current = [];
    anchor.current = null;
    setEntries([]); setErrors({}); setLoading(0);
    requestChapter(index);
  }, [captureAnchor, getChapterRoot, requestChapter]);

  useImperativeHandle(ref, () => ({ seek, getChapterRoot }), [seek, getChapterRoot]);

  const inspect = useCallback(() => {
    const scroll = latest.current.scrollRef.current;
    if (!scroll || pendingSeek.current || !entriesRef.current.length) return;
    const viewport = scroll.getBoundingClientRect();
    const sections = entriesRef.current.map((entry) => ({ entry, element: getChapterRoot(entry.id) }))
      .filter((value): value is { entry: Entry; element: HTMLElement } => Boolean(value.element));
    if (!sections.length) return;
    const readingLine = viewport.top + 60;
    const current = sections.find(({ element }) => element.getBoundingClientRect().bottom > readingLine) ?? sections[sections.length - 1]!;
    const bounds = current.element.getBoundingClientRect();
    const isLast = current.entry.index === latest.current.chapters.length - 1;
    const atBookEnd = isLast && scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 2;
    const progress = atBookEnd ? 100 : Math.max(0, Math.min(100, (readingLine - bounds.top) / Math.max(1, bounds.height) * 100));
    latest.current.onPosition(current.entry.id, progress);
    const first = sections[0]!;
    const last = sections[sections.length - 1]!;
    const margin = Math.max(400, scroll.clientHeight);
    const previous = latest.current.chapters[first.entry.index - 1];
    const next = latest.current.chapters[last.entry.index + 1];
    if (previous && first.element.getBoundingClientRect().top > viewport.top - margin && !errorsRef.current[previous.id]) requestChapter(first.entry.index - 1);
    if (next && last.element.getBoundingClientRect().bottom < viewport.bottom + margin && !errorsRef.current[next.id]) requestChapter(last.entry.index + 1);
  }, [getChapterRoot, requestChapter]);
  inspectRef.current = inspect;

  useLayoutEffect(() => {
    const scroll = latest.current.scrollRef.current;
    const pending = pendingSeek.current;
    const target = pending && getChapterRoot(pending.id);
    if (scroll && pending && target) {
      const offset = target.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
      scroll.scrollTop = Math.max(0, offset + target.offsetHeight * pending.progress / 100 - 60);
      pendingSeek.current = null;
      captureAnchor();
    } else restoreAnchor();
    if (entries.length) latest.current.onReady();
    inspect();
  }, [entries, errors, captureAnchor, getChapterRoot, inspect, restoreAnchor]);

  useEffect(() => {
    mounted.current = true;
    seek(latest.current.initialChapterId);
    const scroll = latest.current.scrollRef.current;
    const onScroll = () => {
      captureAnchor();
      if (frame.current !== undefined) return;
      frame.current = window.requestAnimationFrame(() => { frame.current = undefined; inspect(); });
    };
    const onResize = () => { restoreAnchor(); captureAnchor(); inspect(); };
    const observer = new ResizeObserver(onResize);
    if (container.current) observer.observe(container.current);
    scroll?.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      mounted.current = false;
      generation.current += 1;
      for (const controller of requests.current.values()) controller.abort();
      requests.current.clear();
      observer.disconnect();
      scroll?.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      if (frame.current !== undefined) window.cancelAnimationFrame(frame.current);
    };
  }, [captureAnchor, inspect, restoreAnchor, seek]);

  const previousErrors = Object.entries(errors).filter(([id]) => latest.current.chapters.findIndex((chapter) => chapter.id === id) < (entries[0]?.index ?? 0));
  const followingErrors = Object.entries(errors).filter(([id]) => !previousErrors.some(([previousId]) => previousId === id));
  const renderError = ([id, message]: [string, string]) => <div key={id} className="book-continuous-error" role="alert"><span>{message}</span><button type="button" onClick={() => { captureAnchor(); setErrors((previous) => { const next = { ...previous }; delete next[id]; return next; }); requestChapter(latest.current.chapters.findIndex((chapter) => chapter.id === id)); }}>重试</button></div>;

  return <div ref={container} className="book-continuous-content" aria-busy={loading > 0}>
    {!entries.length && loading > 0 && <p role="status" className="book-continuous-status">正在读取章节…</p>}
    {previousErrors.map(renderError)}
    {entries.map((entry) => <section key={entry.id} data-book-chapter-id={entry.id} className="book-continuous-chapter"><div data-speech-content>{entry.content}</div></section>)}
    {followingErrors.map(renderError)}
    {entries.length > 0 && loading > 0 && <span role="status" className="book-continuous-loading">正在加载相邻章节…</span>}
  </div>;
});
