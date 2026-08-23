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
    expect(html).toContain("orientation: landscape");
    expect(html).toContain('data-reading-mode="paged"');
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
