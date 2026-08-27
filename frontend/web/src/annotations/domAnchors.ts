import type { AnnotationThread, TextAnchor } from "./types";

const MARK_SELECTOR = "mark[data-content-annotation]";
const EXPLANATION_MARK_SELECTOR = "mark[data-reader-explanation]";

export interface ReaderExplanationAnchor extends TextAnchor {
  count: number;
}

function textNodes(root: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest("script,style,textarea,input,button,[aria-hidden='true']")) {
        return NodeFilter.FILTER_REJECT;
      }
      return node.textContent ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  let node = walker.nextNode();
  while (node) {
    nodes.push(node as Text);
    node = walker.nextNode();
  }
  return nodes;
}

function boundaryTextNode(target: Node, localOffset: number, edge: "start" | "end"): { node: Text; offset: number } | undefined {
  if (target instanceof Text) return { node: target, offset: localOffset };
  if (!(target instanceof Element)) return undefined;
  const candidates = Array.from(target.childNodes);
  const indexes = edge === "start"
    ? Array.from({ length: candidates.length - localOffset }, (_, index) => localOffset + index)
    : Array.from({ length: localOffset }, (_, index) => localOffset - index - 1);
  for (const index of indexes) {
    const candidate = candidates[index]!;
    if (candidate instanceof Text) {
      return { node: candidate, offset: edge === "start" ? 0 : candidate.data.length };
    }
    const walker = document.createTreeWalker(candidate, NodeFilter.SHOW_TEXT);
    const found = edge === "start"
      ? walker.nextNode()
      : (() => { let last: Node | null = null; let node = walker.nextNode(); while (node) { last = node; node = walker.nextNode(); } return last; })();
    if (found instanceof Text) return { node: found, offset: edge === "start" ? 0 : found.data.length };
  }
  return undefined;
}

function nodeOffset(nodes: Text[], target: Node, localOffset: number, edge: "start" | "end"): number | null {
  const boundary = boundaryTextNode(target, localOffset, edge);
  if (!boundary) return null;
  let offset = 0;
  for (const node of nodes) {
    if (node === boundary.node) return offset + boundary.offset;
    offset += node.data.length;
  }
  return null;
}

export function textAnchorFromRange(
  root: HTMLElement,
  range: Range,
  contextCharacters = 80,
): TextAnchor | undefined {
  if (!root.contains(range.commonAncestorContainer)) return undefined;
  const nodes = textNodes(root);
  const startOffset = nodeOffset(nodes, range.startContainer, range.startOffset, "start");
  const endOffset = nodeOffset(nodes, range.endContainer, range.endOffset, "end");
  if (startOffset === null || endOffset === null || endOffset <= startOffset) return undefined;
  const fullText = nodes.map((node) => node.data).join("");
  const quote = fullText.slice(startOffset, endOffset);
  if (!quote.trim() || quote.length > 4000) return undefined;
  return {
    quote,
    prefix: fullText.slice(Math.max(0, startOffset - contextCharacters), startOffset),
    suffix: fullText.slice(endOffset, endOffset + contextCharacters),
    startOffset,
    endOffset,
  };
}

function locateAnchor(text: string, anchor: TextAnchor): [number, number] | undefined {
  if (
    anchor.startOffset !== null
    && anchor.endOffset !== null
    && text.slice(anchor.startOffset, anchor.endOffset) === anchor.quote
  ) {
    return [anchor.startOffset, anchor.endOffset];
  }
  const candidates: number[] = [];
  let cursor = text.indexOf(anchor.quote);
  while (cursor >= 0) {
    const prefixMatches = !anchor.prefix || text.slice(Math.max(0, cursor - anchor.prefix.length), cursor) === anchor.prefix;
    const end = cursor + anchor.quote.length;
    const suffixMatches = !anchor.suffix || text.slice(end, end + anchor.suffix.length) === anchor.suffix;
    if (prefixMatches && suffixMatches) candidates.push(cursor);
    cursor = text.indexOf(anchor.quote, cursor + Math.max(1, anchor.quote.length));
  }
  return candidates.length === 1 ? [candidates[0]!, candidates[0]! + anchor.quote.length] : undefined;
}

function textSlices(
  nodes: Text[],
  start: number,
  end: number,
): Array<{ node: Text; start: number; end: number }> {
  let position = 0;
  const slices: Array<{ node: Text; start: number; end: number }> = [];
  for (const node of nodes) {
    const nodeStart = position;
    const nodeEnd = position + node.data.length;
    const sliceStart = Math.max(start, nodeStart);
    const sliceEnd = Math.min(end, nodeEnd);
    if (sliceEnd > sliceStart) {
      slices.push({ node, start: sliceStart - nodeStart, end: sliceEnd - nodeStart });
    }
    position = nodeEnd;
  }
  return slices;
}

export function clearAnnotationMarks(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>(MARK_SELECTOR).forEach((mark) => mark.replaceWith(...mark.childNodes));
  root.normalize();
}

function wrapTextSlice(node: Text, start: number, end: number, annotationId: string, onOpen: (id: string) => void): void {
  if (end <= start) return;
  const selected = start > 0 ? node.splitText(start) : node;
  if (end - start < selected.data.length) selected.splitText(end - start);
  const mark = document.createElement("mark");
  mark.dataset.contentAnnotation = annotationId;
  mark.className = "content-annotation-mark";
  mark.tabIndex = 0;
  mark.setAttribute("role", "button");
  mark.setAttribute("aria-label", "打开这处划线的评论");
  const open = () => onOpen(annotationId);
  mark.addEventListener("click", (event) => {
    event.stopPropagation();
    open();
  });
  mark.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      open();
    }
  });
  selected.replaceWith(mark);
  mark.append(selected);
}

export function clearReaderExplanationMarks(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>(EXPLANATION_MARK_SELECTOR)
    .forEach((mark) => mark.replaceWith(...mark.childNodes));
  root.normalize();
}

function wrapReaderExplanationSlice(
  node: Text,
  start: number,
  end: number,
  explanation: ReaderExplanationAnchor,
  onOpen: (explanation: ReaderExplanationAnchor) => void,
): void {
  if (end <= start) return;
  const selected = start > 0 ? node.splitText(start) : node;
  if (end - start < selected.data.length) selected.splitText(end - start);
  const mark = document.createElement("mark");
  mark.dataset.readerExplanation = "true";
  mark.title = `这段话已查询 ${explanation.count} 次，点击查看解释`;
  mark.tabIndex = 0;
  mark.setAttribute("role", "button");
  mark.setAttribute("aria-label", `查看 AI 解释，这段话已查询 ${explanation.count} 次`);
  const open = (event: Event) => {
    event.stopPropagation();
    onOpen(explanation);
  };
  mark.addEventListener("click", open);
  mark.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open(event);
    }
  });
  selected.replaceWith(mark);
  mark.append(selected);
}

export function renderReaderExplanationMarks(
  root: HTMLElement,
  explanations: ReaderExplanationAnchor[],
  onOpen: (explanation: ReaderExplanationAnchor) => void,
): number {
  clearReaderExplanationMarks(root);
  let rendered = 0;
  for (const explanation of explanations) {
    const nodes = textNodes(root);
    const fullText = nodes.map((node) => node.data).join("");
    const located = locateAnchor(fullText, explanation);
    if (!located) continue;
    const slices = textSlices(nodes, ...located);
    for (const slice of slices.reverse()) {
      wrapReaderExplanationSlice(slice.node, slice.start, slice.end, explanation, onOpen);
    }
    rendered += 1;
  }
  return rendered;
}

export function renderAnnotationMarks(
  root: HTMLElement,
  threads: AnnotationThread[],
  onOpen: (id: string) => void,
): number {
  clearAnnotationMarks(root);
  let rendered = 0;
  for (const thread of threads) {
    const nodes = textNodes(root);
    const fullText = nodes.map((node) => node.data).join("");
    const located = locateAnchor(fullText, thread);
    if (!located) continue;
    const slices = textSlices(nodes, ...located);
    for (const slice of slices.reverse()) wrapTextSlice(slice.node, slice.start, slice.end, thread.id, onOpen);
    rendered += 1;
  }
  return rendered;
}
