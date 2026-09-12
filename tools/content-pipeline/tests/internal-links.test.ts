import { describe, expect, it } from "vitest";
import * as cheerio from "cheerio";
import type { JojoCanonicalChapter } from "@jojo/content";
import { downgradeUnresolvedInternalLinks } from "../src/internal-links";

function chapter(id: string, value: string): JojoCanonicalChapter {
  return { id, title: id, order: 1, body: { format: "html", value }, assetRefs: [] };
}

describe("unresolved book links", () => {
  it("accepts generated annotation destinations only in their owning chapter", () => {
    const chapters = [chapter("one", '<a href="#annotation:1">[1]</a><a href="#annotation:2">[2]</a>'), chapter("two", "正文")];
    const result = downgradeUnresolvedInternalLinks(chapters, [
      { id: "annotation:1", targetId: "one", kind: "footnote", label: "1", body: { format: "text", value: "原注" } },
      { id: "annotation:2", targetId: "two", kind: "footnote", label: "2", body: { format: "text", value: "另一章的注" } },
    ]);
    expect(result.unresolved).toEqual([{ chapterId: "one", reference: "one#annotation:2", label: "[2]" }]);
    const $ = cheerio.load(result.chapters[0]!.body.value);
    expect($('a[href="#annotation:1"]').text()).toBe("[1]");
  });
  it("keeps an unmatched zero marker as non-clickable text without deleting its formatting or anchor", () => {
    const source = chapter("one", '<p>正文<a id="ref0" href="#note0"><sup>(0)</sup></a>1）因为增长。</p>');
    const result = downgradeUnresolvedInternalLinks([source]);
    const $ = cheerio.load(result.chapters[0]!.body.value);
    expect($("a")).toHaveLength(0);
    expect($("span#ref0 sup").text()).toBe("(0)");
    expect($("p").text()).toBe("正文(0)1）因为增长。");
    expect(result.unresolved).toEqual([{ chapterId: "one", reference: "one#note0", label: "(0)" }]);
    expect(source.body.value).toContain('<a id="ref0"');
  });

  it("preserves verified local and cross-chapter links, including a real zero note", () => {
    const chapters = [
      chapter("one", '<p><a href="#note0">(0)</a><a href="#%E6%B3%A8">中文</a><a href="#next" data-target-id="two" data-anchor-id="next">下一章注释</a><a href="#" data-target-id="two">章首</a><a href="https://example.com/#source">来源</a></p><p id="note0">零号确实存在</p><p id="注">本章注释</p>'),
      chapter("two", '<p id="next">跨章注释</p>'),
    ];
    const result = downgradeUnresolvedInternalLinks(chapters);
    expect(result.unresolved).toEqual([]);
    expect(result.chapters).toEqual(chapters);
    expect(result.chapters[0]).toBe(chapters[0]);
  });

  it("does not guess a target from another chapter or keep malformed and removed-volume destinations", () => {
    const result = downgradeUnresolvedInternalLinks([
      chapter("one", '<p><a id="local" href="#note">[1]</a><a id="wrong" href="#note" data-target-id="missing" data-anchor-id="note">[2]</a><a id="encoding" href="#%E0%A4%A">[3]</a></p>'),
      chapter("two", '<p id="note">同名但不属于原链接的注释</p>'),
    ]);
    const $ = cheerio.load(result.chapters[0]!.body.value);
    expect($("a,[href],[data-target-id],[data-anchor-id]")).toHaveLength(0);
    expect($("span[id]")).toHaveLength(3);
    expect($("p").text()).toBe("[1][2][3]");
    expect(result.unresolved).toHaveLength(3);
  });
});
