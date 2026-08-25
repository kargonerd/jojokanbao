import { describe, expect, it } from "vitest";
import { articleId, normalizeArticleUrl } from "../src/identity.js";

describe("article identity", () => {
  it("removes tracking parameters and fragments before hashing", () => {
    const first = normalizeArticleUrl("https://Example.com/story/?utm_source=x&id=1#section");
    const second = normalizeArticleUrl("https://example.com/story?id=1");
    expect(first).toBe(second);
    expect(articleId("example", first)).toBe(articleId("example", second));
  });

  it("unifies The Paper mobile and desktop article URLs", () => {
    expect(normalizeArticleUrl("https://m.thepaper.cn/detail/33845618"))
      .toBe(normalizeArticleUrl("https://www.thepaper.cn/newsDetail_forward_33845618"));
  });
});
