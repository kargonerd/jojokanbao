import { describe, expect, it } from "vitest";
import { bookSearchIndex } from "../src/search";

describe("bookSearchIndex", () => {
  it("stores semantic HTML as compact plain-text blocks", () => {
    const search = bookSearchIndex({
      itemId: "example:full-book",
      chapters: [{
        id: "chapter:1",
        order: 1,
        title: "第一章",
        body: {
          format: "html",
          profile: "jojo-semantic-html/1",
          value: "<h1 id=\"opening\">第一章</h1><p> 第一段　正文 </p><blockquote><p>引文</p></blockquote><p><br></p>",
        },
        assetRefs: [],
      }],
    });

    expect(search).toEqual({
      formatVersion: "jojo-book-search/1",
      itemId: "example:full-book",
      blocks: [
        { targetId: "chapter:1", anchorId: "opening", order: 1, text: "第一章" },
        { targetId: "chapter:1", order: 2, text: "第一段 正文" },
        { targetId: "chapter:1", order: 3, text: "引文" },
      ],
    });
  });

  it("splits plain text on blank lines", () => {
    const search = bookSearchIndex({
      itemId: "example:plain",
      chapters: [{
        id: "chapter:plain",
        order: 1,
        title: "正文",
        body: { format: "text", value: "第一段\n\n第二段" },
        assetRefs: [],
      }],
    });
    expect(search.blocks.map((block) => block.text)).toEqual(["第一段", "第二段"]);
  });
});
