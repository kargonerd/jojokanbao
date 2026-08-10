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

  it("normalizes reliably paired plain-text footnotes and adjacent markers", () => {
    const diagnostics: Parameters<typeof convertWereadChapter>[1] = [];
    const result = convertWereadChapter({
      id: "chapter:plain",
      sourceCid: "plain",
      sourceFiles: [],
      title: "纯文本章",
      order: 1,
      level: 1,
      contentType: "text/plain",
      content: "甲[1][2]乙\n\n[1] 第一条注释\n\n[2] 第二条注释",
    }, diagnostics);

    expect(result.annotations.map(({ label, body }) => [label, body.value])).toEqual([
      ["1", "第一条注释"],
      ["2", "第二条注释"],
    ]);
    expect(result.chapter.body.value).not.toContain("第一条注释");
    expect(result.chapter.body.value.match(/data-annotation-id=/g)).toHaveLength(2);
  });

  it("turns a leading-star editor note into an annotation", () => {
    const diagnostics: Parameters<typeof convertWereadChapter>[1] = [];
    const result = convertWereadChapter({
      id: "chapter:star",
      sourceCid: "star",
      sourceFiles: [],
      title: "中国人民站起来了",
      order: 1,
      level: 1,
      contentType: "application/xhtml+xml",
      content: "<html><body><p>（一九四九年九月二十一日）</p><p>*这是编者注</p><p>正文</p></body></html>",
    }, diagnostics);

    expect(result.annotations).toMatchObject([{ kind: "editor-note", label: "*", body: { value: "这是编者注" } }]);
    expect(result.chapter.body.value).not.toContain("这是编者注");
    expect(result.chapter.body.value).toContain("data-annotation-id=");
  });

  it("separates an editor note joined to the date paragraph", () => {
    const diagnostics: Parameters<typeof convertWereadChapter>[1] = [];
    const result = convertWereadChapter({
      id: "chapter:inline-star",
      sourceCid: "inline-star",
      sourceFiles: [],
      title: "三大运动的伟大胜利",
      order: 1,
      level: 1,
      contentType: "application/xhtml+xml",
      content: "<html><body><p>（一九五一年十月二十三日）*这是开会词。</p><p>正文</p></body></html>",
    }, diagnostics);

    expect(result.annotations).toMatchObject([{ kind: "editor-note", body: { value: "这是开会词。" } }]);
    expect(result.chapter.body.value).toContain("（一九五一年十月二十三日）<sup");
    expect(result.chapter.body.value).not.toContain("这是开会词");
  });
});
