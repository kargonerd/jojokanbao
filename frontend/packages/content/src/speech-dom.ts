import { SPEECH_EXCLUDED_ELEMENTS } from "./speech";

/** Read and reveal spoken text without visual highlights or DOM text mutations. Self-contained for native WebView injection. */
export function createSpeechReader(root: HTMLElement, viewport: () => { left: number; top: number; right: number; bottom: number }, excluded: string) {
  const doc = root.ownerDocument;
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
  function show(segments: string[], index: number, reveal?: (range: Range) => void) {
    if (!reveal) return;
    const { text, nodes } = snapshot();
    let cursor = 0, start = -1;
    for (let i = 0; i <= index; i++) {
      const value = (segments[i] ?? "").replace(/\s/gu, "");
      start = value ? text.indexOf(value, cursor) : -1;
      if (start >= 0) cursor = start + value.length;
    }
    if (start >= 0) {
      const first = nodes.find((item) => item.start + item.offsets.length > start);
      const last = nodes.find((item) => item.start + item.offsets.length >= cursor);
      if (first && last) {
        const activeRange = doc.createRange();
        activeRange.setStart(first.node, first.offsets[start - first.start]!);
        activeRange.setEnd(last.node, last.offsets[cursor - last.start - 1]! + 1);
        reveal(activeRange);
      }
    }
  }
  return { read, show };
}

export { SPEECH_EXCLUDED_ELEMENTS };
