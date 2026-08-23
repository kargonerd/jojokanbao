import type { JojoCatalogEntry, JojoDatasetItemSummary } from "@jojo/content";
import { describe, expect, it } from "vitest";
import {
  createMobileBookSearchResult,
  fuzzyBookTitleScore,
  selectPublishedBooks,
  selectPublishedBookVolumes,
} from "./books";

describe("mobile book catalog", () => {
  it("keeps only published books and series in title order", () => {
    const entries = [
      { datasetId: "paper", type: "newspaper", title: "报纸", indexObject: "paper.jox", language: "zh" },
      { datasetId: "draft", type: "book", title: "草稿", indexObject: "draft.jox", language: "zh", publicationStatus: "draft" },
      { datasetId: "b", type: "book-series", title: "乙书", indexObject: "b.jox", language: "zh" },
      { datasetId: "a", type: "book", title: "甲书", indexObject: "a.jox", language: "zh" },
    ] satisfies JojoCatalogEntry[];
    expect(selectPublishedBooks(entries).map((book) => book.datasetId)).toEqual(["a", "b"]);
  });

  it("sorts published volumes by order and then title", () => {
    const base = { type: "book-volume", manifestObject: "manifest.jox" } as const;
    const items = [
      { ...base, itemId: "b", itemKey: "b", title: "乙", order: 2 },
      { ...base, itemId: "draft", itemKey: "draft", title: "草稿", order: 0, publicationStatus: "draft" },
      { ...base, itemId: "a", itemKey: "a", title: "甲", order: 1 },
    ] satisfies JojoDatasetItemSummary[];
    expect(selectPublishedBookVolumes(items).map((item) => item.itemId)).toEqual(["a", "b"]);
  });

  it("uses the same fuzzy title matching as the Web library", () => {
    expect(fuzzyBookTitleScore("《资本论》第一卷", "资本论")).toBeLessThan(Number.POSITIVE_INFINITY);
    expect(fuzzyBookTitleScore("马克思恩格斯文集", "马恩文")).toBeLessThan(Number.POSITIVE_INFINITY);
    expect(fuzzyBookTitleScore("毛泽东选集", "资本论")).toBe(Number.POSITIVE_INFINITY);
  });

  it("builds a bounded in-book search excerpt with an exact match", () => {
    const result = createMobileBookSearchResult(
      "chapter-1",
      "第一章",
      `${"前".repeat(80)}劳动创造价值${"后".repeat(100)}`,
      "创造价值",
    );
    expect(result).toMatchObject({
      chapterId: "chapter-1",
      chapterTitle: "第一章",
      match: "创造价值",
      leadingEllipsis: true,
      trailingEllipsis: true,
    });
    expect(result?.before.endsWith("劳动")).toBe(true);
  });
});
