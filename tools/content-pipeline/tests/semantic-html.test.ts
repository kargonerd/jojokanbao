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
});
