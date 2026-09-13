import { describe, expect, it } from "vitest";
import type { JojoFragment } from "@jojo/content";
import { DomUtils, parseDocument } from "htmlparser2";
import { bookChapterAnchorId, createBookChapterMarkup, createBookDocument } from "./bookDocument";

const fragment: JojoFragment = {
  formatVersion: "jojo-fragment/1",
  itemId: "volume-1",
  fragmentId: "chapter-1",
  type: "chapter",
  order: 1,
  title: "第一章",
  body: { format: "html", value: '<h1>第一章</h1><p onclick="bad()">正文</p><figure data-asset-id="cover"></figure><script>bad()</script>' },
  assetRefs: ["cover"],
  annotations: [{
    id: "note-1",
    targetId: "chapter-1",
    kind: "footnote",
    label: "1",
    body: { format: "text", value: "原注内容" },
  }],
};

describe("createBookDocument", () => {
  const render = (title: string, body: string) => createBookDocument({
    fragment: { ...fragment, title, body: { format: "html", value: body } },
    assetUrls: {}, textScale: 1, lineHeight: 1.95, firstLineIndent: true,
    eInk: false, readingMode: "paged", paperColor: "ivory",
  });

  it("keeps the original title and linked note instead of adding the title twice", () => {
    const title = "非洲当前的任务是反对帝国主义，不是反对资本主义";
    const heading = `<h1>${title}<a href="#wz_1_21" id="wzyy_1_21"><sup>[1]</sup></a></h1>`;
    const body = `${heading}<p>（一九五九年二月二十一日）</p><p id="wz_1_21">原注</p>`;
    const html = render(title, body);
    const nodes = parseDocument(html).children;
    const renderedHeading = DomUtils.findOne((element) => element.name === "h1", nodes)!;
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(DomUtils.textContent(renderedHeading)).toBe(`${title}[1]`);
    expect(DomUtils.findOne((element) => element.name === "a", renderedHeading.children)?.attribs)
      .toMatchObject({ "data-reader-anchor-id": "wzyy_1_21", "data-reader-href-anchor-id": "wz_1_21" });
    expect(html).toContain("（一九五九年二月二十一日）");
  });

  it("compares decoded entities and inline formatting without rewriting the heading", () => {
    const heading = '<h2><em>A &amp; B</em>&nbsp;论<a href="#note"><sup>2</sup></a></h2>';
    const html = render("A & B 论", `${heading}<p id="note">注释正文</p>`);
    expect(html).not.toContain("<h1>");
    const renderedHeading = DomUtils.findOne((element) => element.name === "h2", parseDocument(html).children)!;
    expect(DomUtils.textContent(renderedHeading)).toBe("A & B\u00a0论2");
    expect(DomUtils.findOne((element) => element.name === "em", renderedHeading.children)).not.toBeNull();
    expect(DomUtils.findOne((element) => element.name === "a", renderedHeading.children)?.attribs["data-reader-href-anchor-id"])
      .toBe("note");
  });

  it.each([
    ["x", "<h1>x<sup>2</sup></h1>"],
    ["目录标题", "<h1>不同的正文标题</h1>"],
    ["第一章", '<h1>第一章<a href="https://example.com/">[1]</a></h1>'],
  ])("keeps distinct headings and meaningful superscripts for %s", (title, body) => {
    const html = render(title, body);
    expect(html).toContain(`<article data-reader-chapter-id="chapter-1"><h1>${title}</h1>`);
    expect(html).toContain(body);
  });

  it("renders trusted reading content without executable markup", () => {
    const html = createBookDocument({
      fragment,
      assetUrls: { cover: "data:image/jpeg;base64,abc" },
      textScale: 1.12,
      lineHeight: 2.15,
      firstLineIndent: true,
      eInk: true,
      readingMode: "paged",
      paperColor: "dark",
    });
    expect(html).toContain("第一章");
    expect(html).toContain("正文");
    expect(html).toContain("data:image/jpeg;base64,abc");
    expect(html).toContain("原注内容");
    expect(html).toContain("font-size: 17.92px");
    expect(html).toContain("line-height: 2.15");
    expect(html).toContain("text-indent: 2em");
    expect(html).toContain("column-count: 2");
    expect(html).toContain("column-fill: auto");
    expect(html).toContain("height: 100vh");
    expect(html).toContain("padding: 5rem 2rem");
    expect(html).toContain("padding: 5rem 4rem");
    expect(html).toContain("orientation: landscape");
    expect(html).toContain('data-reading-mode="paged"');
    expect(DomUtils.findOne((element) => "data-book-content" in element.attribs, parseDocument(html).children)?.attribs["data-target-id"])
      .toBe("chapter-1");
    expect(html).toContain("background: #ffffff");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("bad()");
    expect(html.match(/<h1>第一章<\/h1>/g)).toHaveLength(1);
  });

  it("keeps scrolling mode as one centered continuous column", () => {
    const html = createBookDocument({
      fragment,
      assetUrls: {},
      textScale: 1,
      lineHeight: 1.75,
      firstLineIndent: false,
      eInk: false,
      readingMode: "scroll",
      paperColor: "dark",
    });
    expect(html).toContain('data-reading-mode="scroll"');
    expect(html).toContain("max-width: 52rem");
    expect(html).toContain("padding: 5rem 1.35rem");
    expect(html).toContain("html, body, article { overflow-anchor: none; }");
    expect(html).toContain("[data-reader-chapter-slot] article { padding-top: 2rem; padding-bottom: 2rem; }");
    expect(html).toContain("text-indent: 0");
    expect(html).not.toContain("column-count: 2");
    expect(html).not.toContain("height: 100vh");
    expect(html).toContain("background: #202321");
    expect(html).toContain("color: #deded8");
  });

  it("renders a two-way footnote link without swallowing following text", () => {
    const html = createBookDocument({
      fragment: {
        ...fragment,
        body: { format: "html", value: '<p>正文<sup data-annotation-id="note-1">后续正文</sup></p>' },
      },
      assetUrls: {},
      textScale: 1,
      lineHeight: 1.95,
      firstLineIndent: true,
      eInk: false,
      readingMode: "paged",
      paperColor: "ivory",
    });
    expect(html).toContain('id="reader-chapter:chapter-1:annotation-ref-note-1"');
    expect(html).toContain('href="#reader-chapter%3Achapter-1%3Anote-1"');
    expect(html).toContain('id="reader-chapter:chapter-1:note-1"');
    expect(html).toContain('href="#reader-chapter%3Achapter-1%3Aannotation-ref-note-1"');
    expect(html).toContain("[1]</a></sup>后续正文");
    expect(html).not.toContain("跳转到原注");
  });

  it("renders the Web reader's cross-volume original-note action", () => {
    const html = createBookDocument({
      fragment: {
        ...fragment,
        annotations: [{ ...fragment.annotations[0]!, body: { format: "text", value: "见本书第二卷《另一章》注〔3〕。" } }],
      },
      assetUrls: {},
      textScale: 1,
      lineHeight: 1.95,
      firstLineIndent: true,
      eInk: false,
      readingMode: "paged",
      paperColor: "ivory",
    });
    expect(html).toContain("跳转到原注");
    expect(html).toContain('data-reference-volume="2"');
    expect(html).toContain('data-reference-chapter="另一章"');
    expect(html).toContain('data-reference-label="3"');
  });
});

describe("createBookChapterMarkup", () => {
  it("isolates repeated content and footnote anchors between adjacent chapters", () => {
    const body = '<h2 id="section">章节小节</h2><p><a href="#section">回到小节</a><sup data-annotation-id="note-1"></sup></p>';
    const first = { ...fragment, body: { format: "html" as const, value: body } };
    const second = { ...first, fragmentId: "chapter-2", title: "第二章" };
    const markup = createBookChapterMarkup(first, {}) + createBookChapterMarkup(second, {});
    const nodes = parseDocument(markup).children;
    const chapters = DomUtils.findAll((element) => element.name === "article", nodes);
    expect(chapters.map((chapter) => chapter.attribs["data-reader-chapter-id"]))
      .toEqual(["chapter-1", "chapter-2"]);
    const ids = DomUtils.findAll((element) => Boolean(element.attribs.id), nodes).map((element) => element.attribs.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const chapter of chapters) {
      const localIds = new Set(DomUtils.findAll((element) => Boolean(element.attribs.id), chapter.children)
        .map((element) => element.attribs.id));
      const links = DomUtils.findAll((element) => element.attribs.href?.startsWith("#") ?? false, chapter.children);
      expect(links).toHaveLength(3);
      for (const link of links) {
        expect(localIds.has(decodeURIComponent(link.attribs.href!.slice(1)))).toBe(true);
      }
      expect(DomUtils.findOne((element) => element.attribs["data-reader-anchor-id"] === "section", chapter.children)).not.toBeNull();
      expect(DomUtils.findOne((element) => "data-book-content" in element.attribs, chapter.children)?.attribs["data-target-id"])
        .toBe(chapter.attribs["data-reader-chapter-id"]);
    }
    expect(markup).not.toContain("<html");
    expect(markup).not.toContain("<nav");
  });

  it("preserves original cross-chapter targets and decoded anchors", () => {
    const markup = createBookChapterMarkup({
      ...fragment,
      body: {
        format: "html",
        value: '<p id="小节:1"><a data-target-id="另一章" data-anchor-id="小节:1" href="#%E5%B0%8F%E8%8A%82%3A1">另一章小节</a><a href="#bad%anchor">旧锚点</a></p>',
      },
    }, {});
    const nodes = parseDocument(markup).children;
    const link = DomUtils.findOne((element) => element.name === "a" && element.attribs["data-target-id"] === "另一章", nodes)!;
    expect(link.attribs["data-anchor-id"]).toBe("小节:1");
    expect(link.attribs["data-reader-href-anchor-id"]).toBe("小节:1");
    expect(decodeURIComponent(link.attribs.href!.slice(1))).toBe(bookChapterAnchorId("另一章", "小节:1"));
    expect(markup).toContain('data-reader-anchor-id="小节:1"');
    expect(markup).toContain('data-reader-href-anchor-id="bad%anchor"');
    expect(bookChapterAnchorId("a:b", "c")).not.toBe(bookChapterAnchorId("a", "b:c"));
  });

  it("uses the same sanitized chapter markup in a complete reader document", () => {
    const options = {
      fragment, assetUrls: { cover: 'https://example.com/cover.jpg?x="bad"' },
      textScale: 1, lineHeight: 1.95, firstLineIndent: true,
      eInk: false, readingMode: "scroll" as const, paperColor: "ivory" as const,
    };
    const markup = createBookChapterMarkup(options.fragment, options.assetUrls);
    expect(createBookDocument(options)).toContain(markup);
    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("onclick");
    expect(markup).not.toContain("bad()");
    expect(DomUtils.findOne((element) => element.name === "img", parseDocument(markup).children)?.attribs.src)
      .toBe(options.assetUrls.cover);
  });
});
