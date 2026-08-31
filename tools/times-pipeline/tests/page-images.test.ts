import { describe, expect, it } from "vitest";
import { discoverArticleImages, type ArticleImageExtractor } from "../src/capture/page-images.js";

describe("publisher editorial image candidates", () => {
  it("bypasses keyword heuristics only for an explicitly trusted candidate", () => {
    const html = "<main><article></article></main>";
    const pageUrl = "https://publisher.example/story";
    const extractor: ArticleImageExtractor = () => [
      {
        sourceUrl: "https://publisher.example/editorial-billboard.jpg",
        role: "content",
        alt: "A news photograph containing a company logo",
        width: 1200,
        height: 800,
        publisherEditorial: true,
      },
      {
        sourceUrl: "https://publisher.example/site-logo.svg",
        role: "content",
        alt: "Publisher logo",
        width: 300,
        height: 100,
      },
      {
        sourceUrl: "https://publisher.example/editorial-divider.jpg",
        role: "content",
        alt: "A trusted decorative divider",
        width: 600,
        height: 14,
        publisherEditorial: true,
      },
    ];

    expect(discoverArticleImages(html, pageUrl, undefined, extractor)).toEqual([
      expect.objectContaining({
        sourceUrl: "https://publisher.example/editorial-billboard.jpg",
        alt: "A news photograph containing a company logo",
        publisherEditorial: true,
      }),
    ]);
  });
});
