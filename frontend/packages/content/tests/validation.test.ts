import { describe, expect, it } from "vitest";
import { asJojoBookSearchIndex, asJojoDatasetIndex } from "../src";

const legacyIndex = {
  formatVersion: "jojo-dataset/1",
  revision: 1,
  datasetId: "legacy-books",
  type: "book",
  title: "旧版书库",
  language: "zh-CN",
  items: [{
    itemId: "legacy-books:full-book",
    itemKey: "full-book",
    type: "book",
    order: 1,
    title: "旧版书籍",
    manifestObject: "items/full-book/manifest.jox",
  }],
};

describe("asJojoDatasetIndex", () => {
  it("normalizes the early v1 delivery label when the index shape is complete", () => {
    expect(asJojoDatasetIndex(legacyIndex)).toEqual({
      ...legacyIndex,
      formatVersion: "jojo-delivery-index/1",
    });
  });

  it("does not mistake a canonical dataset descriptor for a delivery index", () => {
    expect(() => asJojoDatasetIndex({
      formatVersion: "jojo-dataset/1",
      datasetId: "canonical-books",
      type: "book",
      title: "规范数据",
      language: "zh-CN",
      itemPath: "items/{itemId}.json.gz",
    })).toThrow("Expected jojo-delivery-index/1, received jojo-dataset/1");
  });
});

describe("asJojoBookSearchIndex", () => {
  it("accepts the lightweight per-book text search format", () => {
    const index = {
      formatVersion: "jojo-book-search/1",
      itemId: "example:full-book",
      blocks: [{ targetId: "chapter:1", order: 1, text: "正文" }],
    };
    expect(asJojoBookSearchIndex(index)).toBe(index);
  });

  it("rejects unrelated search objects", () => {
    expect(() => asJojoBookSearchIndex({ formatVersion: "jojo-search-document/1" }))
      .toThrow("Expected jojo-book-search/1");
  });
});
