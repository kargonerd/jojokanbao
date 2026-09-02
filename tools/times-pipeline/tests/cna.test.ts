import { describe, expect, it } from "vitest";
import { discoverArticleImages } from "../src/capture/page-images.js";
import { extractArticleBody } from "../src/content/body.js";
import { attachAssetsToBody } from "../src/process/article.js";
import { cnaFetch } from "../src/sources/cna/fetch.js";
import { extractCnaImages } from "../src/sources/cna/images.js";
import type { CapturedAsset } from "../src/types.js";

const pageUrl = "https://www.channelnewsasia.com/asia/indonesia-escalates-battle-wildfires-putrid-haze-6349301";
const page = `<article class="node node--article-content"><div class="content">
  <figure class="figure detail-hero-media">
    <picture width="747" height="598"><img src="/hero.jpg" alt="Indonesia haze"></picture>
    <figcaption><p>A man is silhouetted against the haze. (AP Photo/Muhammad Fajri)</p></figcaption>
  </figure>
  <section class="block-field-blocknodearticlefield-content"><div class="content-wrapper">
    <div class="text-long">
      <p>Indonesia intensified efforts to <a href="/sustainability/cloud-seeding">fight wildfires with cloud seeding</a> as residents battled the haze.</p>
      <h2>‘GODZILLA’ EL NINO</h2>
    </div>
    <figure>
      <img src="/inline.jpg">
      <figcaption>Smoke rises from a wildfire and experts expect a severe season.<span>…</span><span class="hidden"> (Photo: AFP/Dito)</span><a class="more">see more</a></figcaption>
    </figure>
    <div class="text-long"><p>Officials distributed masks and expanded cloud-seeding operations across the affected provinces.</p></div>
  </div></section>
  <section class="also-worth-reading"><figure><img src="/recommendation.jpg"></figure></section>
</div></article>`;

function asset(id: string, role: "lead" | "content", afterBlock?: number): CapturedAsset {
  return {
    id,
    type: "image",
    role,
    sourceUrl: `https://www.channelnewsasia.com/${id}.jpg`,
    rawObject: `raw/cna/assets/${id}.jpg`,
    mediaType: "image/jpeg",
    size: 1,
    sha256: id,
    ...(afterBlock !== undefined ? { afterBlock } : {}),
  };
}

describe("CNA semantic article capture", () => {
  it("preserves publisher links and short section headings", () => {
    const body = extractArticleBody(page, cnaFetch, { minimumCharacters: 100, minimumParagraphs: 2 }, undefined, pageUrl);

    expect(body).toContain("<h2>‘GODZILLA’ EL NINO</h2>");
    expect(body).toContain('href="https://www.channelnewsasia.com/sustainability/cloud-seeding"');
    expect(body).not.toContain("recommendation.jpg");
  });

  it("captures hero and inline figures with complete captions and source order", () => {
    const images = discoverArticleImages(page, pageUrl, extractCnaImages);

    expect(images.map((image) => image.sourceUrl)).toEqual([
      "https://www.channelnewsasia.com/hero.jpg",
      "https://www.channelnewsasia.com/inline.jpg",
    ]);
    expect(images[0]).toMatchObject({ role: "lead", caption: "A man is silhouetted against the haze. (AP Photo/Muhammad Fajri)" });
    expect(images[1]).toMatchObject({ role: "content", afterBlock: 2 });
    expect(images[1]?.caption).toBe("Smoke rises from a wildfire and experts expect a severe season. (Photo: AFP/Dito)");
  });

  it("places an inline image after the same body block as the publisher page", () => {
    const body = "<p>First paragraph with enough reported text for the article.</p><h2>‘GODZILLA’ EL NINO</h2><p>Following paragraph with more reporting.</p>";
    const archived = attachAssetsToBody(body, [asset("lead", "lead"), asset("inline", "content", 2)]);

    expect(archived.indexOf('data-asset-id="lead"')).toBeLessThan(archived.indexOf("First paragraph"));
    expect(archived.indexOf("‘GODZILLA’ EL NINO")).toBeLessThan(archived.indexOf('data-asset-id="inline"'));
    expect(archived.indexOf('data-asset-id="inline"')).toBeLessThan(archived.indexOf("Following paragraph"));
  });
});
