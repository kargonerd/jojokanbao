import { describe, expect, it } from "vitest";
import { discoverArticleImages } from "../src/capture/page-images.js";
import { attachAssetsToBody } from "../src/process/article.js";
import { extractNytImages } from "../src/sources/nyt/images.js";
import { extractNytBody } from "../src/sources/nyt/process.js";
import type { CapturedAsset } from "../src/types.js";

describe("NYT image extraction", () => {
  it("positions the publisher lead after the standfirst and keeps body images out of recirculation", () => {
    const html = `<!doctype html><html><head>
      <meta property="og:image" content="https://static01.nyt.com/unrelated-social-card.jpg">
    </head><body><main><article id="story">
      <header><h1>Google Maps Changes Lake Ontario to Lake America</h1></header>
      <p id="article-summary">Users in the United States will see the new label, following President Trump's executive order last week.</p>
      <figure data-testid="image-lead">
        <picture>
          <source srcset="/maps/map-600.jpg 600w, /maps/map-1600.jpg 1600w">
          <img src="/maps/map-placeholder.jpg" alt="A Google map of Lake Ontario" width="1600" height="900">
        </picture>
        <figcaption><span>Google Maps displayed the new Lake America label.</span><span data-testid="image-credit">Google Maps</span></figcaption>
      </figure>
      <section name="articleBody">
        <p>Users in the United States will see the new label, following the executive order.</p>
        <p>Canada has rejected the proposed name and continues to use Lake Ontario.</p>
      </section>
      <figure class="StoryBodyCompanionColumn">
        <img data-src="/photos/toronto-1200.jpg" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP" alt="Toronto at sunset" width="1200" height="800">
        <figcaption>
          <span>Lake Ontario in Toronto. Ontario is a historical Indigenous name for the lake, predating the creation of Canada and the United States.</span>
          <span class="css-image-credit">Eugen Sakhnenko for The New York Times</span>
        </figcaption>
      </figure>
      <section name="articleBody">
        <p>Canadians have rallied behind Mr. Carney during the dispute with their neighbor.</p>
      </section>
      <h2>Related Content</h2>
      <div data-testid="related-content"><img src="/related/recommendation.jpg" width="1200" height="800"></div>
    </article></main></body></html>`;

    expect(extractNytImages(html, "https://www.nytimes.com/2026/08/30/world/canada/story.html")).toEqual([
      {
        sourceUrl: "https://www.nytimes.com/maps/map-1600.jpg",
        role: "content",
        afterBlock: 1,
        alt: "A Google map of Lake Ontario",
        caption: "Google Maps displayed the new Lake America label. Google Maps",
        credit: "Google Maps",
        width: 1600,
        height: 900,
      },
      {
        sourceUrl: "https://www.nytimes.com/photos/toronto-1200.jpg",
        role: "content",
        afterBlock: 3,
        alt: "Toronto at sunset",
        caption: "Lake Ontario in Toronto. Ontario is a historical Indigenous name for the lake, predating the creation of Canada and the United States. Eugen Sakhnenko for The New York Times",
        credit: "Eugen Sakhnenko for The New York Times",
        width: 1200,
        height: 800,
      },
    ]);
  });

  it("retains the publisher lead role when no standfirst precedes the story", () => {
    const html = `<main><article>
      <h1>A story without a publisher standfirst</h1>
      <figure data-testid="image-lead">
        <img src="/lead-without-summary.jpg" alt="Lead without summary" width="1200" height="800">
        <figcaption>The lead image appears before the body.</figcaption>
      </figure>
      <section name="articleBody">
        <p>The first sufficiently long reporting paragraph begins the explicit article body.</p>
        <p>The second sufficiently long reporting paragraph provides additional context.</p>
      </section>
    </article></main>`;

    expect(extractNytImages(html, "https://www.nytimes.com/story")[0]).toMatchObject({
      sourceUrl: "https://www.nytimes.com/lead-without-summary.jpg",
      role: "lead",
    });
    expect(extractNytImages(html, "https://www.nytimes.com/story")[0]?.afterBlock).toBeUndefined();
  });

  it("counts the standfirst when attaching body images and skips only the recirculation module", () => {
    const pageUrl = "https://www.nytimes.com/story";
    const html = `<main><article>
      <p id="article-summary">The publisher standfirst appears before every paragraph in the delivered article body.</p>
      <section name="articleBody">
        <p>The first article paragraph appears before a mid-story recommendation module.</p>
        <div data-testid="story-recirculation"><img src="/recommendation.jpg"><p>Recommended story</p></div>
        <p>The second legitimate article paragraph follows that recommendation module.</p>
        <figure><img src="/legitimate.jpg" alt="Legitimate story image"><figcaption>A legitimate image after the second paragraph.</figcaption></figure>
        <p>The final article paragraph follows the legitimate story image.</p>
      </section>
    </article></main>`;
    const body = extractNytBody(html, { minimumCharacters: 100, minimumParagraphs: 3 }, pageUrl)!;
    const image = extractNytImages(html, pageUrl)[0]!;
    const asset: CapturedAsset = {
      ...image,
      id: "nyt-inline",
      type: "image",
      rawObject: "raw/nyt/assets/inline.jpg",
      mediaType: "image/jpeg",
      size: 1,
      sha256: "nyt-inline",
    };
    const attached = attachAssetsToBody(body, [asset]);

    expect(image).toMatchObject({ sourceUrl: "https://www.nytimes.com/legitimate.jpg", afterBlock: 3 });
    expect(attached.indexOf("second legitimate article paragraph")).toBeLessThan(attached.indexOf('data-asset-id="nyt-inline"'));
    expect(attached.indexOf('data-asset-id="nyt-inline"')).toBeLessThan(attached.indexOf("final article paragraph"));
    expect(attached).not.toContain("recommendation.jpg");
  });

  it("deduplicates a standfirst repeated as the first body paragraph before attaching a later image", () => {
    const pageUrl = "https://www.nytimes.com/2026/08/30/world/repeated-standfirst.html";
    const repeated = "The visible standfirst is repeated verbatim as the first paragraph in the publisher article body.";
    const html = `<main><article>
      <div id="article-summary"><p>Brief.</p><p>${repeated}</p></div>
      <section name="articleBody">
        <p>${repeated}</p>
        <p>The second unique paragraph supplies additional reporting before the inline photograph.</p>
        <figure><img src="/later-image.jpg" alt="Later story image"><figcaption>The photograph follows the second unique block.</figcaption></figure>
        <p>The final unique paragraph follows the photograph and completes the article fixture.</p>
      </section>
    </article></main>`;
    const body = extractNytBody(html, { minimumCharacters: 100, minimumParagraphs: 3 }, pageUrl)!;
    const image = extractNytImages(html, pageUrl)[0]!;
    const asset: CapturedAsset = {
      ...image,
      id: "nyt-deduplicated-inline",
      type: "image",
      rawObject: "raw/nyt/assets/deduplicated-inline.jpg",
      mediaType: "image/jpeg",
      size: 1,
      sha256: "nyt-deduplicated-inline",
    };
    const attached = attachAssetsToBody(body, [asset]);

    expect(body.match(new RegExp(repeated, "gu"))).toHaveLength(1);
    expect(body).not.toContain("Brief.");
    expect(image).toMatchObject({
      sourceUrl: "https://www.nytimes.com/later-image.jpg",
      role: "content",
      afterBlock: 2,
    });
    expect(attached.indexOf("second unique paragraph")).toBeLessThan(attached.indexOf('data-asset-id="nyt-deduplicated-inline"'));
    expect(attached.indexOf('data-asset-id="nyt-deduplicated-inline"')).toBeLessThan(attached.indexOf("final unique paragraph"));
  });

  it("uses the largest available data-srcset image and removes duplicates and advertising media", () => {
    const html = `<main><article><section name="articleBody">
      <p>This first sufficiently long article paragraph establishes the semantic body.</p>
      <figure><picture><source data-srcset="/photo-small.jpg 320w, /photo-large.jpg 1800w"><img src="/fallback.jpg" alt="News photo"></picture></figure>
      <figure><img srcset="/photo-small.jpg 320w, /photo-large.jpg 1800w" alt="Duplicate news photo"></figure>
      <div aria-label="Advertisement"><img src="/advert.jpg" width="1000" height="600"></div>
    </section></article></main>`;

    expect(extractNytImages(html, "https://www.nytimes.com/story")).toEqual([{
      sourceUrl: "https://www.nytimes.com/photo-large.jpg",
      role: "content",
      afterBlock: 1,
      alt: "News photo",
    }]);
  });

  it("retains official GraphQL news images containing logos but still removes decorative media", () => {
    const html = `<main><article>
      <p id="article-summary">The publisher standfirst explains why the branded subjects are newsworthy.</p>
      <figure data-nyt-official-image="true">
        <img src="/kalshi-billboard.jpg" alt="A Times Square billboard featuring Lionel Messi and the Kalshi logo" width="1200" height="800">
      </figure>
      <figure data-nyt-official-image="true">
        <img src="/section-break.jpg" alt="" width="600" height="14">
      </figure>
      <figure>
        <img src="/publisher-logo.svg" alt="Publisher logo" width="300" height="100">
      </figure>
      <section name="articleBody"><p>A sufficiently long reporting paragraph follows the official publisher media.</p></section>
    </article></main>`;

    const pageUrl = "https://www.nytimes.com/story";
    expect(extractNytImages(html, pageUrl)).toEqual([
      expect.objectContaining({
        sourceUrl: "https://www.nytimes.com/kalshi-billboard.jpg",
        role: "content",
        afterBlock: 1,
      }),
    ]);
    expect(discoverArticleImages(html, pageUrl, extractNytImages)).toEqual([
      expect.objectContaining({
        sourceUrl: "https://www.nytimes.com/kalshi-billboard.jpg",
        alt: "A Times Square billboard featuring Lionel Messi and the Kalshi logo",
      }),
    ]);
  });

  it("keeps each official slideshow together as an ordered carousel", () => {
    const html = `<main><article>
      <p id="article-summary">A publisher standfirst precedes the complete official image slideshow.</p>
      <figure data-nyt-official-image="true" data-nyt-slideshow-id="nyt-slideshow-2" data-nyt-slideshow-order="0" data-nyt-slideshow-total="2">
        <img src="/slide-one.jpg" alt="First slide" width="1200" height="800">
      </figure>
      <figure data-nyt-official-image="true" data-nyt-slideshow-id="nyt-slideshow-2" data-nyt-slideshow-order="1" data-nyt-slideshow-total="2">
        <img src="/slide-two.jpg" alt="Second slide" width="1200" height="800">
      </figure>
      <section name="articleBody"><p>A sufficiently long reporting paragraph follows the slideshow.</p></section>
    </article></main>`;

    expect(extractNytImages(html, "https://www.nytimes.com/story")).toEqual([
      expect.objectContaining({
        sourceUrl: "https://www.nytimes.com/slide-one.jpg",
        role: "content",
        afterBlock: 1,
        presentation: { type: "carousel", id: "nyt-slideshow-2", order: 0, total: 2 },
      }),
      expect.objectContaining({
        sourceUrl: "https://www.nytimes.com/slide-two.jpg",
        role: "content",
        afterBlock: 1,
        presentation: { type: "carousel", id: "nyt-slideshow-2", order: 1, total: 2 },
      }),
    ]);
  });
});
