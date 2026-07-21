import { normalizeUnicode, stopEvent } from "pdfjs-dist/legacy/build/pdf.mjs";

const textLayers = new Map<HTMLDivElement, HTMLDivElement>();
let selectionAbortController: AbortController | null = null;
let previousRange: Range | null = null;

function resetTextLayer(endOfContent: HTMLDivElement, textLayer: HTMLDivElement) {
  textLayer.append(endOfContent);
  endOfContent.style.width = "";
  endOfContent.style.height = "";
  endOfContent.style.userSelect = "";
  textLayer.classList.remove("selecting");
}

function resetAllTextLayers() {
  for (const [textLayer, endOfContent] of textLayers) {
    resetTextLayer(endOfContent, textLayer);
  }
  previousRange = null;
}

function rangeIntersectsNode(range: Range, node: Node): boolean {
  try {
    return range.intersectsNode(node);
  } catch {
    return false;
  }
}

function moveSelectionEndMarker(selection: Selection) {
  const range = selection.getRangeAt(0);
  const modifyStart = previousRange !== null && (
    range.compareBoundaryPoints(Range.END_TO_END, previousRange) === 0
    || range.compareBoundaryPoints(Range.START_TO_END, previousRange) === 0
  );
  let anchor: Node | null = modifyStart ? range.startContainer : range.endContainer;

  if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
  if (anchor instanceof Element && anchor.classList.contains("highlight")) {
    anchor = anchor.parentNode;
  }
  if (!anchor) return;

  if (!modifyStart && range.endOffset === 0) {
    do {
      while (anchor && !anchor.previousSibling) anchor = anchor.parentNode;
      if (!anchor) return;
      anchor = anchor.previousSibling;
    } while (anchor && !anchor.childNodes.length);
  }
  if (!anchor) return;

  const anchorElement = anchor.nodeType === Node.TEXT_NODE
    ? anchor.parentElement
    : anchor instanceof Element
      ? anchor
      : anchor.parentElement;
  const parentTextLayer = anchorElement?.closest<HTMLDivElement>(".textLayer") ?? null;
  const endOfContent = parentTextLayer ? textLayers.get(parentTextLayer) : undefined;
  const insertionParent = anchor.parentElement;
  if (!parentTextLayer || !endOfContent || !insertionParent) return;

  endOfContent.style.width = parentTextLayer.style.width;
  endOfContent.style.height = parentTextLayer.style.height;
  endOfContent.style.userSelect = "text";
  insertionParent.insertBefore(endOfContent, modifyStart ? anchor : anchor.nextSibling);
  previousRange = range.cloneRange();
}

function ensureGlobalSelectionListener() {
  if (selectionAbortController) return;
  selectionAbortController = new AbortController();
  const { signal } = selectionAbortController;
  let pointerDown = false;

  document.addEventListener("pointerdown", () => {
    pointerDown = true;
  }, { signal });
  document.addEventListener("pointerup", () => {
    pointerDown = false;
    resetAllTextLayers();
  }, { signal });
  window.addEventListener("blur", () => {
    pointerDown = false;
    resetAllTextLayers();
  }, { signal });
  document.addEventListener("keyup", () => {
    if (!pointerDown) resetAllTextLayers();
  }, { signal });
  document.addEventListener("selectionchange", () => {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0) {
      resetAllTextLayers();
      return;
    }

    const activeTextLayers = new Set<HTMLDivElement>();
    for (let index = 0; index < selection.rangeCount; index += 1) {
      const range = selection.getRangeAt(index);
      for (const textLayer of textLayers.keys()) {
        if (rangeIntersectsNode(range, textLayer)) activeTextLayers.add(textLayer);
      }
    }
    for (const [textLayer, endOfContent] of textLayers) {
      if (activeTextLayers.has(textLayer)) textLayer.classList.add("selecting");
      else resetTextLayer(endOfContent, textLayer);
    }

    moveSelectionEndMarker(selection);
  }, { signal });
}

/**
 * Mirrors the selection lifecycle used by PDF.js TextLayerBuilder while
 * allowing the Reader to keep its lightweight, demand-loaded page renderer.
 */
export function bindPdfTextLayerSelection(
  textLayer: HTMLDivElement,
  endOfContent: HTMLDivElement,
): () => void {
  const abortController = new AbortController();
  const { signal } = abortController;

  textLayer.tabIndex = 0;
  textLayer.addEventListener("mousedown", () => {
    textLayer.classList.add("selecting");
  }, { signal });
  textLayer.addEventListener("copy", (event) => {
    const clipboardEvent = event as ClipboardEvent;
    const selection = document.getSelection();
    clipboardEvent.clipboardData?.setData(
      "text/plain",
      normalizeUnicode((selection?.toString() ?? "").replaceAll("\0", "")),
    );
    stopEvent(event);
  }, { signal });

  textLayers.set(textLayer, endOfContent);
  ensureGlobalSelectionListener();

  return () => {
    abortController.abort();
    resetTextLayer(endOfContent, textLayer);
    textLayers.delete(textLayer);
    if (textLayers.size === 0) {
      selectionAbortController?.abort();
      selectionAbortController = null;
      previousRange = null;
    }
  };
}
