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

  it("converts source alignment into a safe semantic attribute", () => {
    const diagnostics: Parameters<typeof convertWereadChapter>[1] = [];
    const result = convertWereadChapter({
      id: "chapter:poem",
      sourceCid: "poem",
      sourceFiles: [],
      title: "忆秦娥·娄山关",
      order: 1,
      level: 1,
      contentType: "application/xhtml+xml",
      content: `<html><body>
        <p class="content-right">1935年2月</p>
        <p style="color:red; text-align: center" onclick="evil()">题记</p>
        <p class="copyright" data-align="wide">普通正文<span data-align="right">内文</span></p>
        <p data-role="evil" data-font="comic" data-size="huge" data-width="999">非法属性</p>
      </body></html>`,
    }, diagnostics);

    expect(result.chapter.body.value).toMatch(/<p (?=[^>]*data-align="right")(?=[^>]*data-font="kai")[^>]*>1935年2月<\/p>/);
    expect(result.chapter.body.value).toContain('<p data-align="center">题记</p>');
    expect(result.chapter.body.value).toContain("<p>普通正文内文</p>");
    expect(result.chapter.body.value).toContain("<p>非法属性</p>");
    expect(result.chapter.body.value.match(/data-align=/g)).toHaveLength(2);
    expect(result.chapter.body.value).not.toMatch(/class=|style=|onclick/);
    expect(diagnostics).toEqual([]);
  });

  it("normalizes common publisher classes into source-independent semantics", () => {
    const diagnostics: Parameters<typeof convertWereadChapter>[1] = [];
    const result = convertWereadChapter({
      id: "chapter:semantics",
      sourceCid: "semantics",
      sourceFiles: [],
      title: "语义章",
      order: 1,
      level: 1,
      contentType: "application/xhtml+xml",
      content: `<html><body>
        <p><span class="bold">重点</span><span class="italic">外文</span><span class="underline">下划线</span><span class="linethrough">删除</span>H<span class="sub">2</span>O<span class="super">2</span></p>
        <p class="quotation">块引用</p><p class="quotation-right">右侧引文</p><p><span class="quotation-inline">行内引用</span></p>
        <p class="poemContent-3-fangsong-topbot">诗行</p>
        <p class="wr-translation content-noindent">译文</p>
        <p class="contentCR">居中</p><p class="content_r">右对齐</p>
        <p><span class="kaiti">楷体编者文字</span></p><div class="bgColor">提示内容</div>
        <h1 class="titleUnderline">带线标题</h1><p><span class="xiao wrTitleBold">小号重点</span></p>
      </body></html>`,
    }, diagnostics);

    expect(result.chapter.body.value).toContain("<strong>重点</strong><em>外文</em><u>下划线</u><s>删除</s>H<sub>2</sub>O<sup>2</sup>");
    expect(result.chapter.body.value).toContain('<blockquote data-font="kai">块引用</blockquote>');
    expect(result.chapter.body.value).toMatch(/<blockquote (?=[^>]*data-font="kai")(?=[^>]*data-align="right")[^>]*>右侧引文<\/blockquote>/);
    expect(result.chapter.body.value).toContain('<q data-font="kai">行内引用</q>');
    expect(result.chapter.body.value).toContain('<p data-role="poem" data-indent="none" data-font="fang-song">诗行</p>');
    expect(result.chapter.body.value).toContain('<p data-role="translation" data-indent="none">译文</p>');
    expect(result.chapter.body.value).toContain('<p data-align="center">居中</p>');
    expect(result.chapter.body.value).toContain('<p data-align="right">右对齐</p>');
    expect(result.chapter.body.value).toContain('<span data-font="kai">楷体编者文字</span>');
    expect(result.chapter.body.value).toContain('<blockquote data-role="aside">提示内容</blockquote>');
    expect(result.chapter.body.value).toContain('<h1><u>带线标题</u></h1>');
    expect(result.chapter.body.value).toContain('<strong data-size="small">小号重点</strong>');
    expect(result.chapter.body.value).not.toMatch(/class=|style=/);
    expect(diagnostics).toEqual([]);
  });

  it("pairs parenthesized publisher notes without treating ordinary parentheses as notes", () => {
    const diagnostics: Parameters<typeof convertWereadChapter>[1] = [];
    const result = convertWereadChapter({
      id: "chapter:linked-note",
      sourceCid: "linked-note",
      sourceFiles: [],
      title: "带编者注的正文",
      order: 1,
      level: 1,
      contentType: "application/xhtml+xml",
      content: `<html><body>
        <p>正文<a href="#note-1"><span class="super">(1)</span></a>，后文。</p>
        <p>（2）这是正文，不应被移走。</p>
        <p class="content-k"><a id="note-1" href="#back-1">(1)</a> 第一条编者注。</p>
      </body></html>`,
    }, diagnostics);

    expect(result.annotations).toMatchObject([{ label: "1", body: { value: "第一条编者注。" } }]);
    expect(result.chapter.body.value).toContain("正文<sup data-annotation-id=");
    expect(result.chapter.body.value).not.toContain('<a href="#note-1">');
    expect(result.chapter.body.value).toContain("（2）这是正文，不应被移走。");
    expect(result.chapter.body.value).not.toContain("第一条编者注");
  });

  it("keeps inline glyph images inline and binds image descriptions to figures", () => {
    const diagnostics: Parameters<typeof convertWereadChapter>[1] = [];
    const result = convertWereadChapter({
      id: "chapter:images",
      sourceCid: "images",
      sourceFiles: [],
      title: "图片章",
      order: 1,
      level: 1,
      contentType: "application/xhtml+xml",
      content: `<html><body>
        <p>公式前<img class="h-pic" src="https://example.com/glyph.png"/>公式后</p>
        <div class="qrbodyPic"><img class="width70" src="https://example.com/photo.png"/><p class="imgtitle">图片说明</p></div>
        <p class="signImg"><img src="https://example.com/signature.png" alt="作者签名"/></p>
      </body></html>`,
    }, diagnostics);

    expect(result.chapter.body.value).toMatch(/公式前<span (?=[^>]*data-role="inline-image")(?=[^>]*data-asset-id="asset:image-[^"]+")[^>]*><\/span>公式后/);
    expect(result.chapter.body.value).toMatch(/<figure data-asset-id="asset:image-[^"]+" data-width="70"><figcaption>图片说明<\/figcaption><\/figure>/);
    expect(result.chapter.body.value).toMatch(/<figure data-asset-id="asset:image-[^"]+" data-width="30" data-role="signature"><figcaption>作者签名<\/figcaption><\/figure>/);
    expect(result.assets.map(({ role, caption }) => [role, caption])).toEqual([
      ["inline", null],
      ["content", "图片说明"],
      ["signature", null],
    ]);
    expect(diagnostics).toEqual([]);
  });

  it("keeps every body when an exporter concatenates XHTML files into one chapter", () => {
    const diagnostics: Parameters<typeof convertWereadChapter>[1] = [];
    const result = convertWereadChapter({
      id: "chapter:joined",
      sourceCid: "joined",
      sourceFiles: ["heading.xhtml", "content.xhtml"],
      title: "合并章",
      order: 1,
      level: 1,
      contentType: "application/xhtml+xml",
      content: `<html><head><title>标题页</title></head><body><h1>合并章</h1></body></html>
        <html><head><title>正文页</title></head><body><p>不能丢失的正文</p><p>第二段</p></body></html>`,
    }, diagnostics);

    expect(result.chapter.body.value).toContain("<h1>合并章</h1>");
    expect(result.chapter.body.value).toContain("<p>不能丢失的正文</p>");
    expect(result.chapter.body.value).toContain("<p>第二段</p>");
    expect(diagnostics).toEqual([]);
  });

  it("does not create nested superscripts when source markup is already semantic", () => {
    const result = convertWereadChapter({
      id: "chapter:sup",
      sourceCid: "sup",
      sourceFiles: [],
      title: "上标",
      order: 1,
      level: 1,
      contentType: "application/xhtml+xml",
      content: '<html><body><p>正文<sup><span class="super">1</span></sup></p></body></html>',
    }, []);

    expect(result.chapter.body.value).toContain("正文<sup>1</sup>");
    expect(result.chapter.body.value).not.toContain("<sup><sup>");
  });

  it("unwraps invalid style spans around blocks without losing their text", () => {
    const result = convertWereadChapter({
      id: "chapter:block-span",
      sourceCid: "block-span",
      sourceFiles: [],
      title: "非法外层",
      order: 1,
      level: 1,
      contentType: "application/xhtml+xml",
      content: '<html><body><span class="kaiti"><p>第一段</p><p>第二段</p></span><span class="quotation-inline"><p>整段引文</p></span></body></html>',
    }, []);

    expect(result.chapter.body.value).toContain('<p data-font="kai">第一段</p><p data-font="kai">第二段</p>');
    expect(result.chapter.body.value).toContain('<blockquote data-font="kai">整段引文</blockquote>');
    expect(result.chapter.body.value).not.toMatch(/<span[^>]*><p/);
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

  it("preserves an explicit EPUB footnote label and removes unsafe relative links", () => {
    const diagnostics: Parameters<typeof convertWereadChapter>[1] = [];
    const result = convertWereadChapter({
      id: "chapter:epub",
      sourceCid: "epub",
      sourceFiles: [],
      title: "第一章",
      order: 1,
      level: 1,
      contentType: "application/xhtml+xml",
      content: `<html><body><p>正文<span data-wr-footernote="原注内容" data-jojo-footnote-label="12"></span></p>
        <p><a href="part0047.html#note_12">遗留内部链接</a></p>
        <p><img src="https://example.com/image.png" alt="Image"/></p></body></html>`,
    }, diagnostics);

    expect(result.annotations).toMatchObject([{ label: "12", body: { value: "原注内容" } }]);
    expect(result.chapter.body.value).not.toContain("part0047.html");
    expect(result.chapter.body.value).not.toContain("<figcaption>Image</figcaption>");
    expect(result.assets).toMatchObject([{ alt: null, caption: null }]);
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
