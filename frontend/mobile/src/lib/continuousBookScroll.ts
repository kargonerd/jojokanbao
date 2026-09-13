export interface ContinuousChapter { id: string; title?: string; tocAnchorIds?: string[] }

/** Runs inside the WebView. Slots preserve the book's order while chapter DOMs stay mounted. */
export function createContinuousBookScroll(
  chapters: readonly ContinuousChapter[],
  initialChapterId: string,
  post: (message: unknown) => void,
  prepare: (root: HTMLElement, annotations: unknown[]) => void,
  changed: () => void,
) {
  const roots = new Map<string, HTMLElement>();
  const slots = new Map<string, HTMLElement>();
  const requested = new Set<string>();
  const failed = new Set<string>();
  let anchor: { element: HTMLElement; top: number } | undefined;
  let paused = true;
  let lastChapterId = initialChapterId;
  const topInset = 80;
  const bottomInset = 72;
  const articles = Array.from(document.querySelectorAll<HTMLElement>("article[data-reader-chapter-id]"));
  if (!articles.length) return undefined;
  const marker = document.createComment("continuous-reader");
  articles[0]!.before(marker);
  for (const chapter of chapters) {
    const slot = document.createElement("section");
    slot.dataset.readerChapterSlot = chapter.id;
    slot.style.cssText = `min-height:${Math.max(320, window.innerHeight)}px;overflow-anchor:none;`;
    slot.setAttribute("aria-label", chapter.title || "章节");
    slots.set(chapter.id, slot);
    marker.before(slot);
  }
  for (const article of articles) {
    const id = article.dataset.readerChapterId!;
    const slot = slots.get(id);
    if (!slot) continue;
    slot.replaceChildren(article);
    slot.style.minHeight = "0";
    roots.set(id, article);
  }
  marker.remove();

  function top(element: HTMLElement) { return element.getBoundingClientRect().top + window.scrollY; }
  function visibleIndex() {
    const probe = window.scrollY + topInset;
    let low = 0;
    let high = chapters.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (top(slots.get(chapters[middle]!.id)!) <= probe) low = middle;
      else high = middle - 1;
    }
    return low;
  }
  function captureAnchor() {
    const slot = slots.get(chapters[visibleIndex()]?.id ?? initialChapterId);
    if (!slot) return undefined;
    const blocks = slot.querySelectorAll<HTMLElement>("p,h1,h2,h3,h4,figure,blockquote,li");
    const block = Array.from(blocks).find((element) => element.getBoundingClientRect().bottom > topInset) ?? slot;
    return { element: block, top: block.getBoundingClientRect().top };
  }
  function restoreAnchor(saved: typeof anchor) {
    if (!saved?.element.isConnected) return;
    const delta = saved.element.getBoundingClientRect().top - saved.top;
    if (Math.abs(delta) > .5) window.scrollTo(0, Math.max(0, window.scrollY + delta));
  }
  function current() {
    const id = chapters[visibleIndex()]?.id ?? lastChapterId;
    if (roots.has(id)) lastChapterId = id;
    return position(lastChapterId);
  }
  function position(chapterId: string) {
    const root = roots.get(chapterId);
    if (!root) return undefined;
    const range = Math.max(1, root.getBoundingClientRect().height - window.innerHeight + topInset + bottomInset);
    return { chapterId, root, progress: Math.max(0, Math.min(1, (window.scrollY - top(root) + topInset) / range)) };
  }
  function request(id: string) {
    if (roots.has(id) || requested.has(id) || failed.has(id)) return;
    requested.add(id);
    const slot = slots.get(id);
    if (!slot) return;
    const status = document.createElement("p");
    status.textContent = "正在读取章节…";
    status.setAttribute("role", "status");
    status.style.cssText = "padding:48px 24px;text-align:center;opacity:.6;font:14px sans-serif;";
    slot.replaceChildren(status);
    post({ type: "reader-chapter-request", chapterId: id });
  }
  function loadNearby() {
    if (paused) return;
    const index = visibleIndex();
    for (let candidate = Math.max(0, index - 1); candidate <= Math.min(chapters.length - 1, index + 1); candidate += 1) request(chapters[candidate]!.id);
    // A short chapter can expose more than one following chapter at once.
    for (let candidate = index + 2; candidate < Math.min(chapters.length, index + 5); candidate += 1) {
      if (slots.get(chapters[candidate]!.id)!.getBoundingClientRect().top > window.innerHeight * 2) break;
      request(chapters[candidate]!.id);
    }
  }
  function seek(chapterId: string, progress = 0) {
    const root = roots.get(chapterId);
    if (!root) { request(chapterId); return false; }
    lastChapterId = chapterId;
    const range = Math.max(0, root.getBoundingClientRect().height - window.innerHeight + topInset + bottomInset);
    window.scrollTo(0, Math.max(0, top(root) - topInset + Math.max(0, Math.min(1, progress)) * range));
    anchor = captureAnchor();
    changed();
    loadNearby();
    return true;
  }
  function insert(chapterId: string, html: string, annotations: unknown[] = []) {
    const slot = slots.get(chapterId);
    if (!slot || roots.has(chapterId)) return;
    const template = document.createElement("template");
    template.innerHTML = html;
    const article = template.content.querySelector<HTMLElement>("article[data-reader-chapter-id]");
    if (!article || article.dataset.readerChapterId !== chapterId) return;
    const saved = captureAnchor();
    slot.replaceChildren(article);
    slot.style.minHeight = "0";
    roots.set(chapterId, article);
    requested.delete(chapterId);
    failed.delete(chapterId);
    prepare(article, annotations);
    restoreAnchor(saved);
    anchor = captureAnchor();
    resize?.observe(slot);
    changed();
    loadNearby();
  }
  function fail(chapterId: string) {
    requested.delete(chapterId);
    failed.add(chapterId);
    const slot = slots.get(chapterId);
    if (!slot || roots.has(chapterId)) return;
    const status = document.createElement("div");
    status.style.cssText = "padding:48px 24px;text-align:center;font:14px sans-serif;";
    const text = document.createElement("p");
    text.textContent = "章节暂时无法读取";
    const retry = document.createElement("button");
    retry.textContent = "重新加载";
    retry.style.cssText = "padding:10px 18px;border:1px solid currentColor;background:transparent;color:inherit;font:inherit;";
    retry.addEventListener("click", (event) => { event.stopPropagation(); failed.delete(chapterId); request(chapterId); });
    status.append(text, retry);
    slot.replaceChildren(status);
  }
  function findAnchor(chapterId: string, id: string) {
    const root = roots.get(chapterId);
    return root ? Array.from(root.querySelectorAll<HTMLElement>("[id]")).find((element) => element.id === id || element.dataset.readerAnchorId === id) : undefined;
  }
  const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => {
    if (paused) return;
    restoreAnchor(anchor);
    anchor = captureAnchor();
    changed();
    loadNearby();
  });
  for (const slot of slots.values()) resize?.observe(slot);
  const onScroll = () => { if (paused) return; anchor = captureAnchor(); loadNearby(); };
  window.addEventListener("scroll", onScroll, { passive: true });
  const initial = roots.get(initialChapterId) ?? articles[0]!;
  window.scrollTo(0, Math.max(0, top(initial) - topInset));
  anchor = captureAnchor();
  return {
    current, position, insert, fail, seek, findAnchor,
    root: (id?: string) => id ? roots.get(id) : current()?.root,
    anchors: (id: string) => chapters.find((chapter) => chapter.id === id)?.tocAnchorIds ?? [],
    start: () => { paused = false; anchor = captureAnchor(); loadNearby(); },
  };
}

export const CONTINUOUS_BOOK_SCROLL_FACTORY = createContinuousBookScroll.toString();
