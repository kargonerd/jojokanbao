import { describe, expect, it } from "vitest";
import {
  discoverArticleImages,
  type ArticleImageExtractor,
} from "../src/capture/page-images.js";

describe("source-owned article images", () => {
  it("treats an empty source result as authoritative instead of scanning the page", () => {
    const html = `<head><meta property="og:image" content="/generic-lead.jpg"></head>
      <main><article><img src="/generic-inline.jpg" width="1200" height="800"></article></main>`;
    const extractor: ArticleImageExtractor = () => [];

    expect(discoverArticleImages(html, "https://publisher.example/story", extractor)).toEqual([]);
  });

  it("keeps source-approved subjects containing logo while enforcing hard safety checks", () => {
    const extractor: ArticleImageExtractor = () => [
      {
        sourceUrl: "https://publisher.example/editorial-billboard.jpg",
        role: "content",
        alt: "A news photograph containing a company logo",
        width: 1200,
        height: 800,
      },
      {
        sourceUrl: "javascript:alert(1)",
        role: "content",
        width: 1200,
        height: 800,
      },
      {
        sourceUrl: "https://publisher.example/editorial-divider.jpg",
        role: "content",
        width: 600,
        height: 14,
      },
    ];

    expect(discoverArticleImages("", "https://publisher.example/story", extractor)).toEqual([
      expect.objectContaining({
        sourceUrl: "https://publisher.example/editorial-billboard.jpg",
        alt: "A news photograph containing a company logo",
      }),
    ]);
  });
});
