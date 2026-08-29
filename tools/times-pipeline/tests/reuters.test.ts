import { describe, expect, it } from "vitest";
import { discoverArticleImages } from "../src/capture/page-images.js";
import { reutersFetch } from "../src/sources/reuters/fetch.js";
import { extractReutersImages } from "../src/sources/reuters/images.js";
import { extractReutersBody } from "../src/sources/reuters/process.js";

const gallery = Array.from({ length: 4 }, (_, index) => ({
  type: "image",
  id: `original-${index + 1}`,
  url: `https://cloudfront.example.test/original-${index + 1}.jpg`,
  resizer_url: `https://www.reuters.com/resizer/original-${index + 1}.jpg`,
  width: 5_500 + index,
  height: 3_667 + index,
  alt_text: `Reuters image ${index + 1}`,
  caption: `Full Reuters caption ${index + 1}`,
  authors: `Photographer ${index + 1}`,
}));

const fusion = {
  statusCode: 200,
  result: {
    dateline: ["DUBAI/CAIRO, Aug 29 (Reuters)"],
    content_elements: [
      { type: "paragraph", content: 'First Reuters paragraph contains a <a href="https://www.reuters.com/world/iran/">linked topic</a> and enough reported context.' },
      { type: "header", level: 1, content: "SANCTIONS COMPOUND TOLL ON IRAN'S ECONOMY" },
      { type: "paragraph", content: "Second Reuters paragraph contains the rest of the complete report and supporting details." },
    ],
    related_content: { galleries: [{ type: "gallery", content_elements: gallery }] },
  },
};

const page = `<html><head>
  <meta property="og:image" content="https://www.reuters.com/resizer/cropped.jpg?height=1005&width=1920&smart=true">
  </head><body><script id="fusion-metadata">Fusion.globalContent=${JSON.stringify(fusion)};Fusion.contentCache={};</script></body></html>`;

describe("Reuters publisher metadata", () => {
  it("preserves dateline, links and section headings from Fusion content", () => {
    const body = extractReutersBody(page, { minimumCharacters: 100, minimumParagraphs: 2 }, "https://www.reuters.com/story");

    expect(body).toContain("DUBAI/CAIRO, Aug 29 (Reuters) - First Reuters paragraph");
    expect(body).toContain("<h2>SANCTIONS COMPOUND TOLL ON IRAN'S ECONOMY</h2>");
    expect(body).toContain('href="https://www.reuters.com/world/iran/"');
    expect(body).toContain('rel="noopener noreferrer"');
  });

  it("archives every uncropped gallery image with its caption and dimensions", () => {
    const images = discoverArticleImages(page, "https://www.reuters.com/story", reutersFetch, extractReutersImages);

    expect(images).toHaveLength(4);
    expect(images.map((image) => image.sourceUrl)).toEqual(gallery.map((image) => `${image.resizer_url}?width=1920&quality=85`));
    expect(images[0]).toMatchObject({ role: "lead", caption: "Full Reuters caption 1", width: 1_920, height: 1_280 });
    expect(images[1]).toMatchObject({ role: "content", afterBlock: 0, credit: "Photographer 2" });
    expect(images.some((image) => image.sourceUrl.includes("cropped.jpg"))).toBe(false);
    expect(images.some((image) => /(?:height|smart)=/u.test(image.sourceUrl))).toBe(false);
  });
});
