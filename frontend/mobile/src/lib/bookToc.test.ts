import { describe, expect, it } from "vitest";
import type { JojoChapterDescriptor } from "@jojo/content";
import { bookTocEntries } from "./bookToc";

const chapters: JojoChapterDescriptor[] = ["first", "second"].map((id, order) => ({ id, order, title: id, characterCount: 1000, object: id, size: 100, sha256: "hash" }));

describe("bookTocEntries", () => {
  it("preserves grouping, nested headings, and anchor targets while retaining chapters absent from the TOC", () => {
    expect(bookTocEntries([{ id: "part", order: 0, title: "第一部分", children: [{
      id: "chapter", order: 0, title: "第一章", targetId: "first", children: [{ id: "section", order: 0, title: "一 起点", anchorId: "heading-one" }],
    }] }], chapters)).toEqual([
      { id: "part", title: "第一部分", depth: 0 },
      { id: "chapter", title: "第一章", chapterId: "first", depth: 1 },
      { id: "section", title: "一 起点", chapterId: "first", anchorId: "heading-one", depth: 2 },
      { id: "chapter:second", title: "second", chapterId: "second", depth: 0 },
    ]);
  });

  it("falls back to real chapter titles for older manifests without creating artificial numbering", () => {
    expect(bookTocEntries([], chapters).map(({ title, depth }) => ({ title, depth }))).toEqual([
      { title: "first", depth: 0 }, { title: "second", depth: 0 },
    ]);
  });
});
