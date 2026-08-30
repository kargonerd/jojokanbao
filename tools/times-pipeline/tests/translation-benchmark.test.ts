import { describe, expect, it } from "vitest";
import {
  buildTranslationPrompt,
  extractTranslationBlocks,
  resolveObjectKey,
  splitArticleForTranslation,
  validateTranslation,
  type BenchmarkArticle,
} from "../src/translation/benchmark.js";

const article: BenchmarkArticle = {
  id: "wire:one",
  title: "Central bank holds rates at 5%",
  sourceId: "wire",
  sourceName: "Wire",
  publishedAt: "2026-08-30T00:00:00Z",
  articleObject: "content/newspapers/wire/articles/one.jox",
  blocks: [
    { id: "b1", tag: "p", text: "The central bank held its policy rate at 5%." },
    { id: "b2", tag: "p", text: "Officials said inflation may fall in 2027." },
  ],
  bodyCharacters: 92,
  complexity: 400,
};

describe("translation benchmark", () => {
  it("extracts ordered leaf blocks without duplicating blockquotes", () => {
    expect(extractTranslationBlocks("<h2>Heading</h2><blockquote><p>Quoted text.</p></blockquote><ul><li>First</li><li>Second</li></ul>"))
      .toEqual([
        { id: "b1", tag: "h2", text: "Heading" },
        { id: "b2", tag: "p", text: "Quoted text." },
        { id: "b3", tag: "li", text: "First" },
        { id: "b4", tag: "li", text: "Second" },
      ]);
  });

  it("validates structure, Chinese output and exact numbers", () => {
    const validation = validateTranslation(article, {
      title: "央行将利率维持在5%",
      blocks: [
        { id: "b1", text: "央行将政策利率维持在5%。" },
        { id: "b2", text: "官员表示，通胀可能在2027年下降。" },
      ],
    });
    expect(validation.validStructure).toBe(true);
    expect(validation.numericRecall).toBe(1);
    expect(validation.untranslatedBlocks).toBe(0);
  });

  it("detects missing blocks and numbers", () => {
    const validation = validateTranslation(article, {
      title: "央行维持利率",
      blocks: [{ id: "b1", text: "央行维持政策利率。" }],
    });
    expect(validation.validStructure).toBe(false);
    expect(validation.numericRecall).toBe(0);
  });

  it("builds a strict complete-translation prompt", () => {
    const prompt = buildTranslationPrompt(article);
    expect(prompt).toContain("Do not summarize, omit, merge, add");
    expect(prompt).toContain("Central bank holds rates at 5%");
    expect(prompt).toContain('"id":"b2"');
  });

  it("chunks long articles only at block boundaries", () => {
    const chunks = splitArticleForTranslation(article, 75);
    expect(chunks).toHaveLength(2);
    expect(chunks.flatMap((chunk) => chunk.blocks.map((block) => block.id))).toEqual(["b1", "b2"]);
    expect(chunks[0]?.blocks).toHaveLength(1);
    expect(chunks[1]?.blocks).toHaveLength(1);
  });

  it("resolves relative timeline objects safely", () => {
    expect(resolveObjectKey("content/timeline/index.jox", "dates/2026/08/2026-08-30.jox"))
      .toBe("content/timeline/dates/2026/08/2026-08-30.jox");
  });
});
