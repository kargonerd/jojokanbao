import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { isCopyrightChapterTitle, removeCopyrightToc, removeCopyrightEpubChapters } from "../src/copyright-chapters";
import { buildEpub } from "../src/epub";

describe("copyright chapters", () => {
  it.each(["版权信息", "版权页", "版權信息", "版權頁", " 版权 信息\n"])("recognizes a dedicated page: %s", (title) => {
    expect(isCopyrightChapterTitle(title)).toBe(true);
  });

  it.each(["论版权信息", "第一章 版权制度", "版权信息的历史", "第一卷", "出版说明"])("preserves ordinary chapters: %s", (title) => {
    expect(isCopyrightChapterTitle(title)).toBe(false);
  });

  it("removes copyright navigation while preserving volume containers, IDs and order", () => {
    const body = { id: "toc:body", title: "正文", order: 5, targetId: "chapter:5" };
    const input = [
      { id: "toc:volume", title: "第一卷", order: 1, targetId: "chapter:2", children: [
        { id: "toc:copyright", title: "版权信息", order: 2, targetId: "chapter:2" }, body,
      ] },
      { id: "toc:loose", title: "版权信息", order: 8, children: [
        { ...body, id: "toc:body-2", order: 9 },
      ] },
    ];
    expect(removeCopyrightToc(input, new Set(["chapter:2"]))).toEqual([
      { id: "toc:volume", title: "第一卷", order: 1, children: [body] },
      { ...body, id: "toc:body-2", order: 9 },
    ]);
    expect(input[0]!.targetId).toBe("chapter:2");
  });

  it("patches the existing EPUB and preserves the remaining chapter bytes and filenames", async () => {
    const chapters = ["第一卷", "版权信息", "正文"].map((title, index) => ({
      id: `chapter:${index + 1}`, order: index + 1, title,
      body: { format: "html" as const, value: `<p>${title}内容</p>` }, assetRefs: [],
    }));
    const original = await buildEpub({
      itemId: "merged:volume-1", title: "合并书籍", language: "zh-CN", author: "作者",
      chapters, annotations: [], assets: [], canonicalDatasetDirectory: "unused",
      toc: chapters.map((chapter) => ({ id: `toc:${chapter.id}`, title: chapter.title, order: chapter.order, targetId: chapter.id })),
    });
    const before = await JSZip.loadAsync(original);
    const result = await JSZip.loadAsync(await removeCopyrightEpubChapters(original, chapters, new Set(["chapter:2"])));
    expect(result.file("OEBPS/chapters/chapter-0002.xhtml")).toBeNull();
    for (const file of ["OEBPS/chapters/chapter-0001.xhtml", "OEBPS/chapters/chapter-0003.xhtml"]) {
      expect(await result.file(file)!.async("uint8array")).toEqual(await before.file(file)!.async("uint8array"));
    }
    expect(await result.file("OEBPS/nav.xhtml")!.async("string")).not.toContain("版权信息");
    expect(await result.file("OEBPS/content.opf")!.async("string")).not.toContain('idref="chapter-2"');
    expect(await result.file("mimetype")!.async("string")).toBe("application/epub+zip");
    await expect(removeCopyrightEpubChapters(original, chapters.slice(1), new Set(["chapter:2"]))).rejects.toThrow("spine differs");
    await expect(removeCopyrightEpubChapters(original, chapters, new Set(["chapter:3"]))).rejects.toThrow("ordinary chapter");
  });
});
