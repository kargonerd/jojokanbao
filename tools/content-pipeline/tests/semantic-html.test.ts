import { describe, expect, it } from "vitest";
import { convertWereadChapter } from "../src";

describe("WeRead semantic HTML", () => {
  it("removes source CSS and scripts while preserving semantic content", () => {
    const diagnostics: Parameters<typeof convertWereadChapter>[1] = [];
    const result = convertWereadChapter({
      id: "chapter:1",
      sourceCid: "cid",
      sourceFiles: [],
      title: "第一章",
      order: 1,
      level: 1,
      contentType: "application/xhtml+xml",
      content: `<html><head><style>.red{color:red}</style></head><body>
        <div class="red"><h2 id="section">标题</h2><p onclick="evil()">正文<script>alert(1)</script></p></div>
        <span data-wr-footernote="脚注内容"></span>
        <p><img src="https://res.weread.qq.com/image.png" alt="插图"/></p>
      </body></html>`,
    }, diagnostics);
    expect(result.chapter.body.value).toContain('<h2 id="section">标题</h2>');
    expect(result.chapter.body.value).toContain("正文");
    expect(result.chapter.body.value).not.toMatch(/style=|class=|onclick|script|alert/);
    expect(result.annotations).toHaveLength(1);
    expect(result.chapter.body.value).toContain(`data-annotation-id="${result.annotations[0]!.id}"`);
    expect(result.assets).toHaveLength(1);
    expect(result.chapter.body.value).toContain(`data-asset-id="${result.assets[0]!.id}"`);
    expect(diagnostics).toEqual([]);
  });

  it("drops the exporter footnote icon instead of treating it as a content asset", () => {
    const diagnostics: Parameters<typeof convertWereadChapter>[1] = [];
    const result = convertWereadChapter({
      id: "chapter:1",
      sourceCid: "cid",
      sourceFiles: [],
      title: "第一章",
      order: 1,
      level: 1,
      contentType: "application/xhtml+xml",
      content: '<html><body><img class="qqreader-footnote" src="../Images/note.png" data-wr-footernote="注释"/></body></html>',
    }, diagnostics);
    expect(result.annotations).toHaveLength(1);
    expect(result.assets).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it("keeps title notes outside the numbered footnote sequence", () => {
    const diagnostics: Parameters<typeof convertWereadChapter>[1] = [];
    const result = convertWereadChapter({
      id: "chapter:1",
      sourceCid: "cid",
      sourceFiles: [],
      title: "湖南农民运动考察报告",
      order: 1,
      level: 1,
      contentType: "application/xhtml+xml",
      content: `<html><body>
        <h3 class="chapterTitle">湖南农民运动考察报告<img class="qqreader-footnote" src="../Images/note.png" alt="篇名编者注"/></h3>
        <p>湖南<img class="qqreader-footnote" src="../Images/note.png" alt="湖南注"/>正文</p>
        <p>辛亥革命<img class="qqreader-footnote" src="../Images/note.png" alt="辛亥革命注"/>正文</p>
      </body></html>`,
    }, diagnostics);

    expect(result.annotations.map(({ label, body }) => [label, body.value])).toEqual([
      ["*", "篇名编者注"],
      ["1", "湖南注"],
      ["2", "辛亥革命注"],
    ]);
  });

  it("restarts numbering when one decoded file contains another article", () => {
    const diagnostics: Parameters<typeof convertWereadChapter>[1] = [];
    const result = convertWereadChapter({
      id: "chapter:1",
      sourceCid: "cid",
      sourceFiles: [],
      title: "合并章节",
      order: 1,
      level: 1,
      contentType: "application/xhtml+xml",
      content: `<html><body>
        <h3 class="chapterTitle">第一篇</h3>
        <p>甲<img class="qqreader-footnote" src="../Images/note.png" alt="第一篇注一"/></p>
        <p>乙<img class="qqreader-footnote" src="../Images/note.png" alt="第一篇注二"/></p>
        <h3 class="chapterTitle">第二篇</h3>
        <p>丙<img class="qqreader-footnote" src="../Images/note.png" alt="第二篇注一"/></p>
      </body></html>`,
    }, diagnostics);

    expect(result.annotations.map((annotation) => annotation.label)).toEqual(["1", "2", "1"]);
  });

  it("preserves prose nested by malformed non-void footnote markup", () => {
    const diagnostics: Parameters<typeof convertWereadChapter>[1] = [];
    const result = convertWereadChapter({
      id: "chapter:1",
      sourceCid: "cid",
      sourceFiles: [],
      title: "第一章",
      order: 1,
      level: 1,
      contentType: "application/xhtml+xml",
      content: '<html><body><p>辛亥革命<img class="qqreader-footnote" src="../Images/note.png" alt="注释">，后续正文</img></p></body></html>',
    }, diagnostics);

    expect(result.chapter.body.value).toContain("</sup>，后续正文");
    expect(result.annotations).toHaveLength(1);
  });
});
