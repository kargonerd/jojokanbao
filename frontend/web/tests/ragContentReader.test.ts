import { describe, expect, it } from "vitest";
import type { JojoFragment } from "@jojo/content";
import {
  findReferencedAnnotation,
  parseAnnotationReference,
  renderedBody,
  shouldRenderChapterTitle,
} from "../src/rag/pages/ReaderPage";
import type { JojoCatalogEntry } from "@jojo/content";

describe("content visibility compatibility", () => {
  it("treats old catalog entries as published and public", () => {
    const legacy: JojoCatalogEntry = { datasetId: "legacy", type: "book", title: "旧书", language: "zh-CN", indexObject: "legacy/index.jox" };
    expect(legacy.publicationStatus).toBeUndefined();
    expect(legacy.access).toBeUndefined();
  });
});

describe("RAG content Reader annotations", () => {
  it("keeps semantic source alignment for the book layout", () => {
    const fragment: JojoFragment = {
      formatVersion: "jojo-fragment/1",
      itemId: "book:test",
      fragmentId: "chapter:poem",
      type: "chapter",
      order: 1,
      title: "忆秦娥·娄山关",
      body: {
        format: "html",
        profile: "jojo-semantic-html/1",
        value: '<p>正文</p><p data-align="right">1935年2月</p>',
      },
      assetRefs: [],
      annotations: [],
    };

    const document = new DOMParser().parseFromString(renderedBody(fragment, {}), "text/html");
    expect(document.querySelector('p[data-align="right"]')?.textContent).toBe("1935年2月");
    expect(document.querySelector("p")?.id).toBe("jojo-search-block:chapter:poem:1");
    expect(document.querySelectorAll("p")[1]?.id).toBe("jojo-search-block:chapter:poem:2");
  });

  it("renders block and inline semantic assets without changing their flow", () => {
    const fragment: JojoFragment = {
      formatVersion: "jojo-fragment/1",
      itemId: "book:test",
      fragmentId: "chapter:assets",
      type: "chapter",
      order: 1,
      title: "图片",
      body: {
        format: "html",
        profile: "jojo-semantic-html/1",
        value: `<p data-indent="none">甲<span data-asset-id="asset:glyph" data-role="inline-image"></span>乙</p>
          <figure data-asset-id="asset:photo" data-width="70"><figcaption>图一</figcaption></figure>
          <figure data-asset-id="asset:cover" data-role="cover"></figure>
          <figure data-asset-id="asset:table" data-role="table-image"></figure>`,
      },
      assetRefs: ["asset:glyph", "asset:photo", "asset:cover", "asset:table"],
      annotations: [],
    };

    const document = new DOMParser().parseFromString(renderedBody(fragment, {
      "asset:glyph": "blob:glyph",
      "asset:photo": "blob:photo",
      "asset:cover": "blob:cover",
      "asset:table": "blob:table",
    }), "text/html");
    const inline = document.querySelector('span[data-role="inline-image"]');
    expect(inline?.previousSibling?.textContent).toBe("甲");
    expect(inline?.nextSibling?.textContent).toBe("乙");
    expect(inline?.querySelector("img")?.getAttribute("data-book-inline-asset")).toBe("true");
    const figure = document.querySelector("figure");
    expect(figure?.querySelector("img")?.src).toContain("blob:photo");
    expect(figure?.getAttribute("style")).toContain("max-width: 70%");
    expect(figure?.querySelector("figcaption")?.textContent).toBe("图一");
    expect(document.querySelector('figure[data-role="cover"] img')?.getAttribute("alt")).toBe("封面");
    expect(document.querySelector('figure[data-role="table-image"] img')?.getAttribute("alt")).toBe("表格");
  });

  it("preserves source blank paragraphs and line breaks as book layout", () => {
    const fragment: JojoFragment = {
      formatVersion: "jojo-fragment/1",
      itemId: "book:test",
      fragmentId: "chapter:spacing",
      type: "chapter",
      order: 1,
      title: "正文",
      body: {
        format: "html",
        profile: "jojo-semantic-html/1",
        value: "<p>第一段</p><p>&nbsp;</p><br><p>第二段</p>",
      },
      assetRefs: [],
      annotations: [],
    };

    const document = new DOMParser().parseFromString(renderedBody(fragment, {}), "text/html");
    expect(document.querySelectorAll("p")).toHaveLength(3);
    expect(document.querySelector("body > br")).not.toBeNull();
  });

  it("does not render the source heading twice when it matches the fragment title", () => {
    const fragment: JojoFragment = {
      formatVersion: "jojo-fragment/1",
      itemId: "book:test",
      fragmentId: "chapter:1",
      type: "chapter",
      order: 1,
      title: "第一章",
      body: {
        format: "html",
        profile: "jojo-semantic-html/1",
        value: '<hr id="source"/><h1 id="original-title">第一章</h1><p>正文</p>',
      },
      assetRefs: [],
      annotations: [],
    };

    const document = new DOMParser().parseFromString(renderedBody(fragment, {}), "text/html");
    expect(document.querySelector("h1")).toBeNull();
    expect(document.getElementById("original-title")).not.toBeNull();
    expect(document.body.textContent).toContain("正文");
  });

  it("removes an EPUB table-of-contents heading and its useless self-link", () => {
    const fragment: JojoFragment = {
      formatVersion: "jojo-fragment/1",
      itemId: "book:test",
      fragmentId: "chapter:toc",
      type: "chapter",
      order: 2,
      title: "目录",
      body: {
        format: "html",
        profile: "jojo-semantic-html/1",
        value: '<p>&nbsp;</p><h1 id="toc">目录</h1><p><a href="chapter-1">声明</a></p><p>目录</p>',
      },
      assetRefs: [],
      annotations: [],
    };

    const document = new DOMParser().parseFromString(renderedBody(fragment, {}), "text/html");
    expect(document.querySelector("h1")).toBeNull();
    expect(document.body.textContent?.replace(/\s+/g, "").trim()).toBe("声明");
  });

  it("keeps an imported cover label for navigation without printing it over the cover", () => {
    const fragment: JojoFragment = {
      formatVersion: "jojo-fragment/1",
      itemId: "book:test",
      fragmentId: "chapter:cover",
      type: "chapter",
      order: 1,
      title: "封面",
      body: { format: "html", profile: "jojo-semantic-html/1", value: '<figure data-asset-id="asset:cover"></figure>' },
      assetRefs: ["asset:cover"],
      annotations: [],
    };

    expect(shouldRenderChapterTitle(fragment, '<figure><img src="blob:cover"></figure>')).toBe(false);
    expect(shouldRenderChapterTitle({ ...fragment, title: "第一章" }, "<p>正文</p>")).toBe(true);
  });

  it("renders a stable round-trip link between a marker and its annotation", () => {
    const fragment: JojoFragment = {
      formatVersion: "jojo-fragment/1",
      itemId: "book:test:volume-2",
      fragmentId: "chapter:249",
      type: "chapter",
      order: 1,
      title: "论持久战",
      body: {
        format: "html",
        profile: "jojo-semantic-html/1",
        value: '<p>正文<sup data-annotation-id="annotation:test">不能丢失的后续正文</sup></p>',
      },
      assetRefs: [],
      annotations: [{
        id: "annotation:test",
        targetId: "chapter:249",
        kind: "footnote",
        label: "14",
        body: { format: "text", value: "见本书第一卷《湖南农民运动考察报告》注〔3〕。" },
      }],
    };

    const document = new DOMParser().parseFromString(renderedBody(fragment, {}), "text/html");
    const link = document.querySelector('sup[data-annotation-id="annotation:test"] a');
    expect(link?.textContent).toBe("[14]");
    expect(link?.getAttribute("href")).toBe("#annotation:test");
    expect(document.body.textContent).toContain("[14]不能丢失的后续正文");
  });

  it("parses a cross-volume title and note number without guessing", () => {
    expect(parseAnnotationReference("见本书第一卷《湖南农民运动考察报告》注〔3〕。")).toEqual({
      volumeNumber: 1,
      chapterTitle: "湖南农民运动考察报告",
      annotationLabel: "3",
    });
    expect(parseAnnotationReference("泛泛提到另一篇文章")).toBeUndefined();
  });

  it("resolves printed note numbers without counting a title asterisk note", () => {
    const annotations: JojoFragment["annotations"] = [
      { id: "annotation:title", targetId: "chapter:223", kind: "footnote", label: "1", body: { format: "text", value: "篇名编者注" } },
      { id: "annotation:hunan", targetId: "chapter:223", kind: "footnote", label: "2", body: { format: "text", value: "湖南注" } },
      { id: "annotation:zhao", targetId: "chapter:223", kind: "footnote", label: "3", body: { format: "text", value: "赵恒惕注" } },
      { id: "annotation:xinhai", targetId: "chapter:223", kind: "footnote", label: "4", body: { format: "text", value: "辛亥革命注" } },
    ];
    const fragment: JojoFragment = {
      formatVersion: "jojo-fragment/1",
      itemId: "book:test:volume-1",
      fragmentId: "chapter:223",
      type: "chapter",
      order: 1,
      title: "湖南农民运动考察报告",
      body: {
        format: "html",
        profile: "jojo-semantic-html/1",
        value: `<h3>湖南农民运动考察报告<sup data-annotation-id="annotation:title"></sup></h3>
          <p>湖南<sup data-annotation-id="annotation:hunan"></sup></p>
          <p>赵恒惕<sup data-annotation-id="annotation:zhao"></sup></p>
          <p>辛亥革命<sup data-annotation-id="annotation:xinhai"></sup></p>`,
      },
      assetRefs: [],
      annotations,
    };

    expect(findReferencedAnnotation(fragment, "3")?.id).toBe("annotation:xinhai");
  });
});
