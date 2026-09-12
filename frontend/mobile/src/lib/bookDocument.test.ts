import { describe, expect, it } from "vitest";
import type { JojoFragment } from "@jojo/content";
import { createBookDocument } from "./bookDocument";

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
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain(body);
    expect(html).not.toContain(`<article><h1>${title}</h1>`);
  });

  it("compares decoded entities and inline formatting without rewriting the heading", () => {
    const heading = '<h2><em>A &amp; B</em>&nbsp;论<a href="#note"><sup>2</sup></a></h2>';
    const html = render("A & B 论", `${heading}<p id="note">注释正文</p>`);
    expect(html).not.toContain("<h1>");
    expect(html).toContain(heading);
  });

  it.each([
    ["x", "<h1>x<sup>2</sup></h1>"],
    ["目录标题", "<h1>不同的正文标题</h1>"],
    ["第一章", '<h1>第一章<a href="https://example.com/">[1]</a></h1>'],
  ])("keeps distinct headings and meaningful superscripts for %s", (title, body) => {
    const html = render(title, body);
    expect(html).toContain(`<article><h1>${title}</h1>`);
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
    expect(html).toContain('data-book-content data-target-id="chapter-1"');
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
    expect(html).toContain('id="annotation-ref-note-1"');
    expect(html).toContain('href="#note-1"');
    expect(html).toContain('id="note-1"');
    expect(html).toContain('href="#annotation-ref-note-1"');
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
