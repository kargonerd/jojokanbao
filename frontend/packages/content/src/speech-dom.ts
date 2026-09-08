import { SPEECH_EXCLUDED_ELEMENTS } from "./speech";

/** Self-contained for injection into the native book WebView. No DOM text mutations. */
export function createSpeechReader(root: HTMLElement, viewport: () => { left: number; top: number; right: number; bottom: number }, excluded: string) {
  const doc = root.ownerDocument;
  let activeRange: Range | null = null;
  let overlay: HTMLDivElement | null = null;
  let location: { segments: string[]; index: number; range?: { start: number; end: number } } | null = null;
  function snapshot() {
    const nodes: Array<{ node: Text; start: number; offsets: number[] }> = [];
    let text = "";
    const walker = doc.createTreeWalker(root, 4);
    let current: Node | null;
    while ((current = walker.nextNode())) {
      if (current.parentElement?.closest(excluded)) continue;
      const node = current as Text;
      const offsets: number[] = [];
      for (let i = 0; i < node.data.length; i++) {
        if (!/\s/u.test(node.data[i]!)) offsets.push(i);
      }
      if (!offsets.length) continue;
      nodes.push({ node, start: text.length, offsets });
      text += node.data.replace(/\s/gu, "");
    }
    return { nodes, text };
  }
  function visible(rect: DOMRect, bounds: ReturnType<typeof viewport>) {
    return rect.width > 0 && rect.height > 0 && rect.right > bounds.left && rect.left < bounds.right && rect.bottom > bounds.top && rect.top < bounds.bottom;
  }
  function read() {
    const { nodes, text } = snapshot();
    const bounds = viewport();
    for (const item of nodes) {
      const range = doc.createRange();
      range.selectNodeContents(item.node);
      if (!Array.from(range.getClientRects()).some((rect) => visible(rect, bounds))) continue;
      for (let i = 0; i < item.offsets.length; i++) {
        range.setStart(item.node, item.offsets[i]!);
        range.setEnd(item.node, item.offsets[i]! + 1);
        if (Array.from(range.getClientRects()).some((rect) => visible(rect, bounds))) return { text, offset: item.start + i };
      }
    }
    return { text, offset: 0 };
  }
  function paint() {
    overlay?.replaceChildren();
    if (!activeRange || !root.isConnected) return;
    const bounds = viewport();
    if (!overlay) {
      overlay = doc.createElement("div");
      overlay.setAttribute("data-speech-highlight", "");
      overlay.setAttribute("aria-hidden", "true");
      overlay.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:20;";
      doc.body.appendChild(overlay);
    }
    for (const rect of Array.from(activeRange.getClientRects())) {
      if (!visible(rect, bounds)) continue;
      const mark = doc.createElement("span");
      const left = Math.max(rect.left, bounds.left), top = Math.max(rect.top, bounds.top);
      mark.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${Math.min(rect.right, bounds.right) - left}px;height:${Math.min(rect.bottom, bounds.bottom) - top}px;background:rgba(180,100,40,.22);border-bottom:2px solid #8b1a1a;box-sizing:border-box;`;
      overlay.appendChild(mark);
    }
  }
  function show(segments: string[], index: number, reveal?: (range: Range) => void, range?: { start: number; end: number }) {
    location = { segments, index, range };
    const { text, nodes } = snapshot();
    let cursor = 0, start = -1;
    for (let i = 0; i <= index; i++) {
      const value = (segments[i] ?? "").replace(/\s/gu, "");
      start = value ? text.indexOf(value, cursor) : -1;
      if (start >= 0) cursor = start + value.length;
    }
    if (start >= 0 && range) {
      if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end <= range.start || range.end > cursor - start) start = -1;
      else { cursor = start + range.end; start += range.start; }
    }
    activeRange = null;
    if (start >= 0) {
      const first = nodes.find((item) => item.start + item.offsets.length > start);
      const last = nodes.find((item) => item.start + item.offsets.length >= cursor);
      if (first && last) {
        activeRange = doc.createRange();
        activeRange.setStart(first.node, first.offsets[start - first.start]!);
        activeRange.setEnd(last.node, last.offsets[cursor - last.start - 1]! + 1);
        reveal?.(activeRange);
      }
    }
    paint();
  }
  doc.addEventListener("scroll", paint, true);
  doc.defaultView?.addEventListener("resize", paint);
  const Observer = doc.defaultView?.MutationObserver;
  const observer = Observer ? new Observer(() => { if (location) show(location.segments, location.index, undefined, location.range); }) : null;
  observer?.observe(root, { childList: true, subtree: true, characterData: true });
  return { read, show, paint, clear() { location = null; activeRange = null; overlay?.remove(); overlay = null; }, destroy() {
    location = null; observer?.disconnect();
    activeRange = null; overlay?.remove(); overlay = null;
    doc.removeEventListener("scroll", paint, true);
    doc.defaultView?.removeEventListener("resize", paint);
  } };
}

export { SPEECH_EXCLUDED_ELEMENTS };
