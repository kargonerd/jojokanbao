import { describe, expect, it } from "vitest";
import {
  createBookReaderApplyAnnotationScript,
  createBookReaderBridgeScript,
  createBookReaderClearSelectionScript,
  createBookReaderGoToSpreadScript,
  createBookReaderLocateTextScript,
  createBookReaderRemoveAnnotationScript,
  createBookReaderRevealAnchorScript,
  parseBookReaderMessage,
} from "./bookReaderBridge";

describe("book reader bridge", () => {
  it("accepts page, tap and chapter-boundary messages", () => {
    expect(parseBookReaderMessage('{"type":"reader-tap"}')).toEqual({ type: "reader-tap" });
    expect(parseBookReaderMessage('{"type":"reader-boundary","direction":"next"}')).toEqual({
      type: "reader-boundary",
      direction: "next",
    });
    expect(parseBookReaderMessage('{"type":"reader-page","paged":true,"spreadIndex":1,"spreadCount":4,"pageStart":3,"pageEnd":4,"pageCount":8,"pagesPerSpread":2}')).toMatchObject({
      type: "reader-page",
      pageStart: 3,
      pageEnd: 4,
      pagesPerSpread: 2,
    });
    expect(parseBookReaderMessage('{"type":"reader-selection","text":"选中文字","start":3,"end":8}')).toEqual({
      type: "reader-selection",
      text: "选中文字",
      start: 3,
      end: 8,
    });
    expect(parseBookReaderMessage('{"type":"reader-annotation","id":"note-1"}')).toEqual({
      type: "reader-annotation",
      id: "note-1",
    });
    expect(parseBookReaderMessage('{"type":"reader-internal-link","chapterId":"chapter-2","anchorId":"note-3"}')).toEqual({
      type: "reader-internal-link",
      chapterId: "chapter-2",
      anchorId: "note-3",
    });
    expect(parseBookReaderMessage('{"type":"reader-image","assetId":"asset:1"}')).toEqual({ type: "reader-image", assetId: "asset:1" });
    expect(parseBookReaderMessage('{"type":"reader-cross-reference","volumeNumber":2,"chapterTitle":"第一章","annotationLabel":"3"}')).toMatchObject({
      type: "reader-cross-reference",
      volumeNumber: 2,
      annotationLabel: "3",
    });
  });

  it("ignores malformed messages", () => {
    expect(parseBookReaderMessage("not-json")).toBeNull();
    expect(parseBookReaderMessage('{"type":"reader-boundary","direction":"sideways"}')).toBeNull();
    expect(parseBookReaderMessage('{"type":"reader-page","paged":true}')).toBeNull();
  });

  it("creates an instant horizontal page-turn bridge", () => {
    const startScript = createBookReaderBridgeScript("start");
    const endScript = createBookReaderBridgeScript("end");
    expect(startScript).toContain('article.style.transform = "translate3d(" + (-offset)');
    expect(startScript).not.toContain("window.scrollTo");
    expect(startScript).toContain('turn(dx < 0 ? "next" : "previous")');
    expect(startScript).toContain("window.__jojoReaderGoToSpread");
    expect(startScript).toContain("revealElement(target)");
    expect(startScript).toContain("event.preventDefault()");
    expect(startScript).toContain("data-book-jump-target");
    expect(startScript).toContain("startAtEnd = false");
    expect(endScript).toContain("startAtEnd = true");
  });

  it("can reverse the left and right tap direction without changing swipe direction", () => {
    const script = createBookReaderBridgeScript("start", true);
    expect(script).toContain("var leftTapNext = true");
    expect(script).toContain('turn(leftTapNext ? "next" : "previous")');
    expect(script).toContain('turn(dx < 0 ? "next" : "previous")');
  });

  it("creates a bounded native-to-reader progress command", () => {
    expect(createBookReaderGoToSpreadScript(4)).toBe(
      "window.__jojoReaderGoToSpread && window.__jojoReaderGoToSpread(4); true;",
    );
    expect(createBookReaderGoToSpreadScript(-3)).toContain("(0)");
    expect(createBookReaderGoToSpreadScript(Number.NaN)).toContain("(0)");
    expect(createBookReaderLocateTextScript('</script>正文')).toContain('<\\/script>正文');
    expect(createBookReaderApplyAnnotationScript({ id: "a", start: 2, end: 5 })).toContain("__jojoReaderApplyAnnotation");
    expect(createBookReaderRemoveAnnotationScript("a")).toContain("__jojoReaderRemoveAnnotation");
    expect(createBookReaderClearSelectionScript()).toContain("__jojoReaderClearSelection");
    expect(createBookReaderRevealAnchorScript("note-1")).toContain("__jojoReaderRevealAnchor");
  });

  it("injects persisted highlights and selection reporting", () => {
    const script = createBookReaderBridgeScript("start", false, [{ id: "note-1", start: 4, end: 9 }]);
    expect(script).toContain('\"id\":\"note-1\"');
    expect(script).toContain("reader-selection");
    expect(script).toContain("data-annotation-id");
    expect(script).toContain("__jojoReaderLocateText");
  });
});
