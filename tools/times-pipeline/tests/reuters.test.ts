import { describe, expect, it } from "vitest";
import { discoverArticleImages, type PageImageCandidate } from "../src/capture/page-images.js";
import { attachAssetsToBody } from "../src/process/article.js";
import { extractReutersImages } from "../src/sources/reuters/images.js";
import { extractReutersBody } from "../src/sources/reuters/process.js";
import type { CapturedAsset } from "../src/types.js";

function attachExtracted(body: string | undefined, images: PageImageCandidate[]): string {
  if (!body) throw new Error("Expected Reuters body");
  const assets: CapturedAsset[] = images.map((image, index) => ({
    ...image,
    id: `reuters-asset-${index}`,
    type: "image",
    rawObject: `assets/reuters-${index}.jpg`,
    mediaType: "image/jpeg",
    size: 1,
    sha256: String(index).padStart(64, "0"),
  }));
  return attachAssetsToBody(body, assets);
}

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
    const images = discoverArticleImages(page, "https://www.reuters.com/story", extractReutersImages);

    expect(images).toHaveLength(4);
    expect(images.map((image) => image.sourceUrl)).toEqual(gallery.map((image) => `${image.resizer_url}?width=1920&quality=85`));
    expect(images[0]).toMatchObject({ role: "lead", caption: "Full Reuters caption 1 Photographer 1", width: 1_920, height: 1_280 });
    expect(images[1]).toMatchObject({ role: "content", afterBlock: 0, credit: "Photographer 2" });
    expect(images.some((image) => image.sourceUrl.includes("cropped.jpg"))).toBe(false);
    expect(images.some((image) => /(?:height|smart)=/u.test(image.sourceUrl))).toBe(false);

    const body = extractReutersBody(page, { minimumCharacters: 100, minimumParagraphs: 2 }, "https://www.reuters.com/story");
    const attached = attachExtracted(body, images);
    expect(attached.indexOf('data-asset-id="reuters-asset-0"')).toBeLessThan(attached.indexOf('data-asset-id="reuters-asset-1"'));
    expect(attached.indexOf('data-asset-id="reuters-asset-3"')).toBeLessThan(attached.indexOf("DUBAI/CAIRO"));
  });

  it("resolves relative payload images and rejects unsafe URL protocols", () => {
    const unsafeFusion = {
      statusCode: 200,
      result: {
        related_content: { galleries: [{ type: "gallery", content_elements: [
          { type: "image", url: "/media/relative.jpg", caption: "Relative original" },
          { type: "image", resizer_url: "/resizer/relative.jpg?height=400&smart=true", width: 1_600, height: 900 },
          { type: "image", resizer_url: "javascript:alert(1)", url: "/media/safe-fallback.jpg" },
          { type: "image", url: "javascript:alert(1)" },
          { type: "image", url: "data:image/png;base64,AAAA" },
          { type: "image", resizer_url: "blob:https://www.reuters.com/unsafe", url: "blob:https://www.reuters.com/unsafe" },
        ] }] },
      },
    };
    const html = `<script id="fusion-metadata">Fusion.globalContent=${JSON.stringify(unsafeFusion)};Fusion.contentCache={};</script>`;
    const images = extractReutersImages(html, "https://www.reuters.com/world/example-story");

    expect(images.map((image) => image.sourceUrl)).toEqual([
      "https://www.reuters.com/media/relative.jpg",
      "https://www.reuters.com/resizer/relative.jpg?width=1920&quality=85",
      "https://www.reuters.com/media/safe-fallback.jpg",
    ]);
    expect(images.some((image) => /^(?:javascript|data|blob):/iu.test(image.sourceUrl))).toBe(false);
  });

  it("keeps a publisher-declared editorial image whose subject is a company logo", () => {
    const image = {
      type: "image",
      url: "https://cloudfront.example.test/uber-logo.jpg",
      resizer_url: "https://www.reuters.com/resizer/v2/uber-logo.jpg",
      width: 3_000,
      height: 2_000,
      alt_text: "Illustration shows Uber logo",
      caption: "Uber logo is seen in this editorial illustration.",
      authors: "Reuters Photographer",
    };
    const html = `<script id="fusion-metadata">Fusion.globalContent=${JSON.stringify({
      statusCode: 200,
      result: { thumbnail: image, promo_items: { images: [image] } },
    })};Fusion.contentCache={};</script>`;

    expect(discoverArticleImages(html, "https://www.reuters.com/world/uber", extractReutersImages)).toEqual([
      expect.objectContaining({
        sourceUrl: "https://www.reuters.com/resizer/v2/uber-logo.jpg?width=1920&quality=85",
        role: "lead",
        alt: "Illustration shows Uber logo",
      }),
    ]);
  });

  it("excludes Reuters' default topic thumbnail without hiding editorial logo photos", () => {
    const defaultThumbnail = {
      type: "image",
      id: "466BJJQ7PVGY5O53NZ3KL65MHM",
      url: "https://cloudfront.example.test/reuters-default.png",
      resizer_url: "https://www.reuters.com/resizer/v2/reuters-default.png",
      width: 1_024,
      height: 740,
      alt_text: "Reuters logo",
      subtitle: "TOPIC:DEFAULT_TOPIC_THUMBNAIL",
    };
    const editorialImage = {
      type: "image",
      url: "https://cloudfront.example.test/editorial-logo.jpg",
      resizer_url: "https://www.reuters.com/resizer/v2/editorial-logo.jpg",
      width: 3_000,
      height: 2_000,
      alt_text: "Illustration shows a company logo",
      caption: "A company logo appears in an editorial illustration.",
    };
    const html = `<script id="fusion-metadata">Fusion.globalContent=${JSON.stringify({
      statusCode: 200,
      result: { thumbnail: defaultThumbnail, promo_items: { images: [defaultThumbnail, editorialImage] } },
    })};Fusion.contentCache={};</script>`;

    expect(discoverArticleImages(html, "https://www.reuters.com/business/example", extractReutersImages)).toEqual([
      expect.objectContaining({
        sourceUrl: "https://www.reuters.com/resizer/v2/editorial-logo.jpg?width=1920&quality=85",
        role: "lead",
        alt: "Illustration shows a company logo",
      }),
    ]);
  });
});
