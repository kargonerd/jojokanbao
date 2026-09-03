import { describe, expect, it } from "vitest";
import { discoverArticleImages } from "../src/capture/page-images.js";
import { extractArticleBody } from "../src/content/body.js";
import { attachAssetsToBody } from "../src/process/article.js";
import { africanewsFetch } from "../src/sources/africanews/fetch.js";
import { extractAfricanewsImages } from "../src/sources/africanews/images.js";
import { extractAfricanewsBody } from "../src/sources/africanews/process.js";
import type { CapturedAsset } from "../src/types.js";

describe("Africanews article extraction", () => {
  const html = `<html><head>
    <meta property="og:image" content="/media/lead.jpg">
    <meta property="og:image:alt" content="Residents survey the flooded road">
    <meta property="og:image:width" content="1600">
    <meta property="og:image:height" content="900">
  </head><body><article class="article__body">
    <header class="article__header">
      <div class="c-article-media-copyright">Residents survey the flooded road |
        <span class="c-article__copyright">AFP</span>
      </div>
    </header>
    <div class="article-content">
      <span class="article__flag">Algeria</span>
      <div class="article-content__text">
        <p>Emergency crews reopened the main road after overnight flooding damaged homes and interrupted travel across the region.</p>
        <p>Officials said water levels were falling, although teams remained in several districts to help families return safely.</p>
        <figure><img src="/media/inside.jpg" width="1200" height="800" alt="Crews clear the road"><figcaption>Crews remove debris after the storm.</figcaption></figure>
        <p>Residents were asked to avoid low-lying routes while engineers inspected bridges and restored electricity to nearby villages.</p>
      </div>
    </div>
    <aside class="related-articles"><h2>Related articles</h2>
      <p>A separate election story that must never become part of this report even though it is long enough to pass generic quality checks.</p>
      <img src="/media/unrelated.jpg" width="1200" height="800" alt="Unrelated recommendation">
    </aside>
  </article></body></html>`;

  it("keeps only the publisher story text and excludes the related column", () => {
    const body = extractArticleBody(
      html,
      africanewsFetch,
      { minimumCharacters: 250, minimumParagraphs: 3 },
      extractAfricanewsBody,
      "https://www.africanews.com/2026/08/30/example/",
    );

    expect(body?.match(/<p>/gu)).toHaveLength(3);
    expect(body).toContain("Emergency crews reopened");
    expect(body).not.toContain("Algeria");
    expect(body).not.toContain("Related articles");
    expect(body).not.toContain("separate election story");
  });

  it("keeps the lead credit and only story-owned inline images", () => {
    const images = discoverArticleImages(
      html,
      "https://www.africanews.com/2026/08/30/example/",
      extractAfricanewsImages,
    );

    expect(images).toEqual([
      expect.objectContaining({
        sourceUrl: "https://www.africanews.com/media/lead.jpg",
        role: "lead",
        alt: "Residents survey the flooded road",
        caption: "Residents survey the flooded road AFP",
        credit: "AFP",
      }),
      expect.objectContaining({
        sourceUrl: "https://www.africanews.com/media/inside.jpg",
        role: "content",
        afterBlock: 2,
        caption: "Crews remove debris after the storm.",
      }),
    ]);
    expect(images.map((image) => image.sourceUrl)).not.toContain("https://www.africanews.com/media/unrelated.jpg");
  });

  it("mounts inline media after the same semantic blocks emitted by the body extractor", () => {
    const pageUrl = "https://www.africanews.com/2026/08/30/example/";
    const body = extractAfricanewsBody(html, { minimumCharacters: 250, minimumParagraphs: 3 }, pageUrl)!;
    const candidate = extractAfricanewsImages(html, pageUrl).find((image) => image.role === "content")!;
    const asset: CapturedAsset = {
      ...candidate,
      id: "africanews-inline",
      type: "image",
      rawObject: "raw/africanews/assets/inside.jpg",
      mediaType: "image/jpeg",
      size: 1,
      sha256: "africanews-inline",
    };
    const attached = attachAssetsToBody(body, [asset]);

    expect(attached.indexOf("water levels were falling")).toBeLessThan(attached.indexOf('data-asset-id="africanews-inline"'));
    expect(attached.indexOf('data-asset-id="africanews-inline"')).toBeLessThan(attached.indexOf("Residents were asked"));
  });

  it("uses the source adapter's alternate-template fallback when the publisher body container is absent", () => {
    const alternate = `<meta property="og:image" content="/alternate-lead.jpg"><div class="article__body">
      <p>A complete alternate-template paragraph appears before the inline publisher photograph.</p>
      <figure><img src="/alternate-inline.jpg" width="1200" height="800"></figure>
    </div>`;
    const images = discoverArticleImages(
      alternate,
      "https://www.africanews.com/alternate",
      extractAfricanewsImages,
    );

    expect(images.map((image) => image.sourceUrl)).toEqual([
      "https://www.africanews.com/alternate-lead.jpg",
      "https://www.africanews.com/alternate-inline.jpg",
    ]);
  });
});
