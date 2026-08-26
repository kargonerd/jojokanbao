import { describe, expect, it } from "vitest";
import { searchJojoBookIndex } from "../src";

const index = {
  formatVersion: "jojo-book-search/1" as const,
  itemId: "book-a:item-a",
  blocks: [
    { targetId: "chapter:1", order: 1, text: "第一章 这是关于劳动与价值的正文。" },
    { targetId: "chapter:2", order: 2, text: "第二章讨论机器。" },
  ],
};

describe("searchJojoBookIndex", () => {
  it("finds normalized text and returns a compact source location", () => {
    expect(searchJojoBookIndex(index, "劳动与价值", { before: 2, after: 2 }))
      .toEqual([{
        targetId: "chapter:1",
        order: 1,
        excerpt: "…关于劳动与价值的正…",
        matchText: "劳动与价值",
      }]);
  });

  it("returns no match for a semantic-only query so callers can fall back", () => {
    expect(searchJojoBookIndex(index, "剩余价值理论")).toEqual([]);
  });

  it("ranks explanatory body text above copyright metadata and bare headings", () => {
    const result = searchJojoBookIndex({
      formatVersion: "jojo-book-search/1",
      itemId: "book-a:item-a",
      blocks: [
        { targetId: "copyright", order: 1, text: "版权信息 书名：剩余价值理论" },
        { targetId: "heading", order: 2, text: "剩余价值" },
        {
          targetId: "body",
          order: 3,
          text: "工人在必要劳动时间之外继续劳动，所创造的超过劳动力价值的那部分价值形成剩余价值。",
        },
      ],
    }, "剩余价值", { limit: 3 });

    expect(result.map((match) => match.targetId)).toEqual(["body", "heading", "copyright"]);
  });
});
