import { afterEach, describe, expect, it, vi } from "vitest";

const pdfJsMocks = vi.hoisted(() => ({
  normalizeUnicode: vi.fn((value: string) => value.normalize("NFKC")),
  stopEvent: vi.fn((event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  }),
}));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => pdfJsMocks);

import { bindPdfTextLayerSelection } from "../../packages/pdf-viewer/src/textLayerSelection";

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  window.document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("PDF text layer selection", () => {
  it("keeps the selection marker beside the active text and normalizes copied text", () => {
    const textLayer = window.document.createElement("div");
    textLayer.className = "textLayer";
    const first = window.document.createElement("span");
    first.textContent = "第一栏 文字";
    const second = window.document.createElement("span");
    second.textContent = "第二栏文字";
    const endOfContent = window.document.createElement("div");
    endOfContent.className = "endOfContent";
    textLayer.append(first, second, endOfContent);
    window.document.body.append(textLayer);

    const cleanup = bindPdfTextLayerSelection(textLayer, endOfContent);
    const range = window.document.createRange();
    range.selectNodeContents(first);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    window.document.dispatchEvent(new Event("selectionchange"));

    expect(textLayer.classList.contains("selecting")).toBe(true);
    expect(endOfContent.previousSibling).toBe(first);
    expect(endOfContent.style.userSelect).toBe("text");

    const setData = vi.fn();
    const copyEvent = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(copyEvent, "clipboardData", { value: { setData } });
    first.dispatchEvent(copyEvent);

    expect(pdfJsMocks.normalizeUnicode).toHaveBeenCalledWith("第一栏 文字");
    expect(setData).toHaveBeenCalledWith("text/plain", "第一栏 文字");
    expect(copyEvent.defaultPrevented).toBe(true);

    cleanup();
    expect(textLayer.classList.contains("selecting")).toBe(false);
  });

  it("only activates the text layer intersected by the current selection", () => {
    const makeLayer = (text: string) => {
      const layer = window.document.createElement("div");
      layer.className = "textLayer";
      const span = window.document.createElement("span");
      span.textContent = text;
      const end = window.document.createElement("div");
      end.className = "endOfContent";
      layer.append(span, end);
      window.document.body.append(layer);
      return { layer, span, end };
    };
    const first = makeLayer("第一页");
    const second = makeLayer("第二页");
    const cleanupFirst = bindPdfTextLayerSelection(first.layer, first.end);
    const cleanupSecond = bindPdfTextLayerSelection(second.layer, second.end);

    const range = window.document.createRange();
    range.selectNodeContents(first.span);
    window.getSelection()!.addRange(range);
    window.document.dispatchEvent(new Event("selectionchange"));

    expect(first.layer.classList.contains("selecting")).toBe(true);
    expect(second.layer.classList.contains("selecting")).toBe(false);

    cleanupFirst();
    cleanupSecond();
  });
});
