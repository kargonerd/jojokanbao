import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverSource } from "../src/discovery/multi.js";
import { discoverArticleImages } from "../src/capture/page-images.js";
import { attachAssetsToBody } from "../src/process/article.js";
import { apFetch } from "../src/sources/ap/fetch.js";
import { extractApImages } from "../src/sources/ap/images.js";
import { extractApBody, extractApTimestamps } from "../src/sources/ap/process.js";
import type { CapturedAsset, SourceConfig } from "../src/types.js";

const source: SourceConfig = {
  id: "ap",
  name: "AP News",
  language: "en",
  publicationTimeZone: "UTC",
  sections: [{ id: "world", name: "World", url: "https://apnews.com/world-news" }],
  discovery: {
    kind: "multi",
    targets: [{
      id: "world",
      sectionIds: ["world"],
      discovery: {
        kind: "source-adapter",
        adapter: "ap",
        driver: "http",
        path: "/world-news",
        maximumItems: 20,
      },
    }],
  },
  content: { priority: ["captured-page", "discovery-summary"], parser: "ap" },
  fetch: { strategy: "direct-first", bpc: true },
  health: { minimumCandidates: 1 },
  enabled: true,
};

afterEach(() => vi.unstubAllGlobals());

describe("AP source adapter", () => {
  it("reads the original publication and later update times from AP JSON-LD", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      datePublished: "2026-09-02T14:12:37Z",
      dateModified: "2026-09-02T14:43:57Z",
    })}</script>`;

    expect(extractApTimestamps(html)).toEqual({
      publishedAt: "2026-09-02T14:12:37.000Z",
      updatedAt: "2026-09-02T14:43:57.000Z",
    });
    expect(apFetch.revision).toBe("story-media-v3");
  });

  it("keeps story paragraphs that follow an inline AP newsletter module", () => {
    const html = `<main><div class="RichTextStoryBody RichTextBody">
      <p>But not all map providers have followed suit. MapQuest will keep the Lake Ontario label on its platform.</p>
      <div class="HTMLModuleEnhancement">
        <form><p>Sign up for Morning Wire: Our flagship newsletter breaks down the biggest headlines of the day.</p></form>
      </div>
      <div class="optimizelyHubpeekClass"></div>
      <p>MapQuest, owned by California company System1, has reported a surge of downloads recently. On Wednesday, MapQuest topped the charts of free apps with new downloads in both the U.S. and Canada on Apple’s App Store.</p>
    </div></main>`;

    const body = extractApBody(
      html,
      { minimumCharacters: 200, minimumParagraphs: 2 },
      "https://apnews.com/article/apple-lake-ontario-america-google-example",
    );

    expect(body).toContain("MapQuest topped the charts of free apps");
    expect(body).not.toContain("Sign up for Morning Wire");
    expect(body?.match(/<p>/gu)).toHaveLength(2);
  });

  it("archives only the AP story carousel without duplicate overlay or unrelated images", () => {
    const slide = (id: string, caption: string) => `<div class="Carousel-slide"><div class="CarouselSlide">
      <picture><source media="(min-width: 1024px)" width="1440" height="960" data-flickity-lazyload-srcset="https://dims.apnews.com/${id}-1440.jpg 1x, https://dims.apnews.com/${id}-2880.jpg 2x">
      <img alt="${caption}" src="data:image/svg+xml,placeholder"></picture>
    </div></div>`;
    const html = `<main><img src="https://example.com/unrelated.jpg" width="1200" height="800">
      <div class="Carousel-slides">${slide("photo-one", "First AP photo")}${slide("photo-two", "Second AP photo")}</div>
      <div class="CarouselOverlay-slidesColumn"><div class="CarouselSlide"><img alt="Duplicate overlay" data-flickity-lazyload="https://dims.apnews.com/overlay-copy.jpg"></div></div>
    </main>`;

    const images = discoverArticleImages(html, "https://apnews.com/article/example", apFetch, extractApImages);

    expect(images).toEqual([
      expect.objectContaining({ sourceUrl: "https://dims.apnews.com/photo-one-1440.jpg", role: "lead", caption: "First AP photo" }),
      expect.objectContaining({ sourceUrl: "https://dims.apnews.com/photo-two-1440.jpg", role: "content", afterBlock: 0, caption: "Second AP photo" }),
    ]);
    expect(images.map((image) => image.presentation)).toEqual([
      { type: "carousel", id: "ap-primary-gallery", order: 0, total: 2 },
      { type: "carousel", id: "ap-primary-gallery", order: 1, total: 2 },
    ]);
  });

  it("keeps the AP carousel ahead of the first body block when attaching body and images", () => {
    const pageUrl = "https://apnews.com/article/ordered-gallery";
    const slide = (id: string, caption: string) => `<div class="Carousel-slide"><div class="CarouselSlide">
      <img alt="${caption}" data-flickity-lazyload="/${id}.jpg" width="1200" height="800">
    </div></div>`;
    const html = `<main>
      <div class="Carousel-slides">${slide("lead", "Lead AP image")}${slide("second", "Second AP image")}</div>
      <div class="RichTextStoryBody">
        <p>The first AP paragraph contains enough reporting detail to establish the start of the article body.</p>
        <p>The second AP paragraph adds context and confirms that the gallery remains ahead of the prose.</p>
      </div>
    </main>`;
    const body = extractApBody(html, { minimumCharacters: 100, minimumParagraphs: 2 }, pageUrl)!;
    const images = extractApImages(html, pageUrl);
    const assets: CapturedAsset[] = images.map((image, index) => ({
      ...image,
      id: `ap-gallery-${index}`,
      type: "image",
      rawObject: `raw/ap/assets/gallery-${index}.jpg`,
      mediaType: "image/jpeg",
      size: 1,
      sha256: `ap-gallery-${index}`,
    }));
    const attached = attachAssetsToBody(body, assets);

    expect(images).toMatchObject([
      { role: "lead" },
      { role: "content", afterBlock: 0 },
    ]);
    expect(attached.indexOf('data-asset-id="ap-gallery-0"')).toBeLessThan(attached.indexOf('data-asset-id="ap-gallery-1"'));
    expect(attached.indexOf('data-asset-id="ap-gallery-1"')).toBeLessThan(attached.indexOf("The first AP paragraph"));
  });

  it("discovers article metadata from the AP persisted GraphQL query", async () => {
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0]) => new Response(JSON.stringify({
      data: {
        Screen: {
          main: [{
            __typename: "ColumnContainer",
            columns: [{
              __typename: "PageListModule",
              items: [
                {
                  __typename: "PagePromo",
                  id: "story-1",
                  title: "World headline",
                  url: "/article/world-headline",
                  publishDateStamp: "2026-08-25T04:00:00Z",
                  description: "A concise AP summary.",
                  category: "World",
                },
                {
                  __typename: "PagePromo",
                  id: "story-without-date",
                  title: "Undated story",
                  url: "/article/undated",
                },
                {
                  __typename: "PagePromo",
                  id: "entertainment-recommendation",
                  title: "Entertainment quiz promoted inside the section page",
                  url: "/article/entertainment-quiz",
                  publishDateStamp: "2026-08-25T04:05:00Z",
                  category: "Entertainment",
                },
              ],
            }],
          }],
        },
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await discoverSource(source, "2026-08-25T04:10:00Z", Date.parse("2026-08-24T04:10:00Z"));

    expect(result.candidates).toHaveLength(1);
    expect(result.fetchPolicy).toEqual(expect.objectContaining({ capture: "browser" }));
    expect(result.candidates[0]).toEqual(expect.objectContaining({
      canonicalUrl: "https://apnews.com/article/world-headline",
      title: "World headline",
      summary: "A concise AP summary.",
      contentStatus: "summary",
      publisherCategories: ["World"],
      publisherSections: [{ id: "world", name: "World" }],
      upstreamId: "story-1",
    }));
    const requested = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(JSON.parse(requested.searchParams.get("variables") ?? "{}")).toEqual({ path: "/world-news" });
  });

  it("keeps a browser driver extension point without enabling it by default", async () => {
    const browserSource: SourceConfig = {
      ...source,
      discovery: {
        kind: "source-adapter",
        adapter: "ap",
        driver: "browser",
        path: "/world-news",
        maximumItems: 20,
      },
    };

    await expect(discoverSource(browserSource, "2026-08-25T04:10:00Z", 0))
      .rejects.toThrow("browser discovery runtime is not configured");

    const open = vi.fn();
    await expect(discoverSource(browserSource, "2026-08-25T04:10:00Z", 0, { browser: { open } }))
      .rejects.toThrow("ap does not support browser discovery");
    expect(open).not.toHaveBeenCalled();
  });
});
