import { describe, expect, it } from "vitest";
import { fuzzyBookTitleScore } from "../src/book-title-search";

describe("book title matching", () => {
  it.each(["mao", "maozedong", "mao ze dong", "mao'ze'dong", "MAO", "ＭＡＯ", "máo zé dōng", "mzd", "maozed", "mao选集", "毛zedong", "mao xuan"])("matches pinyin input %s", (query) => {
    expect(Number.isFinite(fuzzyBookTitleScore("毛泽东选集", query))).toBe(true);
  });

  it.each([
    ["《资本论》第一卷", "zibenlun"],
    ["马克思恩格斯文集", "makesi"],
    ["马克思恩格斯文集", "mks"],
    ["吕氏春秋", "lvshi"],
    ["吕氏春秋", "lǚ shì"],
    ["重庆谈判", "chongqing"],
    ["毛澤東選集", "maozedong"],
    ["毛泽东年谱：1893—1949", "maozedong1893"],
  ])("matches %s with %s", (title, query) => {
    expect(Number.isFinite(fuzzyBookTitleScore(title, query))).toBe(true);
  });

  it("preserves Chinese fuzzy and English title matching", () => {
    expect(Number.isFinite(fuzzyBookTitleScore("马克思恩格斯文集", "马恩文"))).toBe(true);
    expect(fuzzyBookTitleScore("Capital", "CAP")).toBeLessThan(1);
    expect(fuzzyBookTitleScore("毛泽东选集", "资本论")).toBe(Infinity);
    expect(fuzzyBookTitleScore("毛泽东选集", " ")).toBe(0);
  });

  it("rejects unrelated pinyin, reordered syllables and arbitrary internal letters", () => {
    for (const query of ["zibenlun", "zedongmao", "ao", "xyz", "maozeunknown", "m".repeat(10000)]) {
      expect(fuzzyBookTitleScore("毛泽东选集", query)).toBe(Infinity);
    }
  });

  it("ranks literal titles and contiguous full pinyin above abbreviations with gaps", () => {
    expect(fuzzyBookTitleScore("Mao", "mao")).toBeLessThan(fuzzyBookTitleScore("毛泽东选集", "mao"));
    expect(fuzzyBookTitleScore("毛泽东选集", "mao")).toBeLessThan(fuzzyBookTitleScore("马鞍偶记", "mao"));
    expect(fuzzyBookTitleScore("毛泽东选集", "maozedong")).toBeLessThan(fuzzyBookTitleScore("毛主席与泽东的故事", "maozedong"));
  });
});
