import { describe, expect, it } from "vitest";
import { discoverArticleImages, type PageImageCandidate } from "../src/capture/page-images.js";
import { extractArticleBody } from "../src/content/body.js";
import { attachAssetsToBody } from "../src/process/article.js";
import { extractDwBody } from "../src/sources/dw/body.js";
import { dwFetch } from "../src/sources/dw/fetch.js";
import { extractDwImages } from "../src/sources/dw/images.js";
import type { CapturedAsset } from "../src/types.js";

function attachExtracted(body: string | undefined, images: PageImageCandidate[]): string {
  if (!body) throw new Error("Expected DW body");
  const assets: CapturedAsset[] = images.map((image, index) => ({
    ...image,
    id: `dw-asset-${index}`,
    type: "image",
    rawObject: `assets/dw-${index}.jpg`,
    mediaType: "image/jpeg",
    size: 1,
    sha256: String(index).padStart(64, "0"),
  }));
  return attachAssetsToBody(body, assets);
}

describe("DW article extraction", () => {
  it("keeps story blocks and drops source promotion and feedback", () => {
    const html = `<article>
      <header><figure><img srcset="/lead-600.jpg 600w, /lead-1200.jpg 1200w" alt="Voters wait outside a polling station"></figure></header>
      <div class="content-area"><div class="rich-text">
        <p>Voters took part in a referendum after officials published the proposed constitutional changes earlier this month.</p>
        <h2>What will the referendum decide?</h2>
        <p>The proposal would give the president authority to appoint the prime minister and dissolve parliament under defined conditions.</p>
        <p>Election officials said provisional results would be released after ballots from rural districts had been counted.</p>
        <p><em>Edited by: Example Editor</em></p>
        <p><em>If you rely on our team for trusted reporting, please take a moment to select us as your Preferred Source on Google.</em></p>
      </div></div>
      <footer class="feedback"><h2>Your feedback</h2><p>This feedback prompt is not part of the report and must be excluded.</p></footer>
    </article>`;

    const body = extractArticleBody(
      html,
      dwFetch,
      { minimumCharacters: 250, minimumParagraphs: 3 },
      extractDwBody,
      "https://www.dw.com/en/example/a-123",
    );

    expect(body?.match(/<p>/gu)).toHaveLength(3);
    expect(body).toContain("What will the referendum decide?");
    expect(body).not.toContain("Edited by");
    expect(body).not.toContain("Preferred Source");
    expect(body).not.toContain("Your feedback");
  });

  it("preserves live-blog update headings while excluding embedded media titles", () => {
    const html = `<article>
      <div class="content-block"><h2>What you need to know</h2><div class="rich-text">
        <ul><li>Officials announced a new trade target after the bilateral meeting.</li><li>Emergency teams continued searching flood-damaged districts.</li></ul>
        <p>This live blog brings together the day's main developments from across the country and neighboring states.</p>
      </div></div>
      <section class="liveblog-post"><h2>Leaders announce a new trade target</h2><div class="rich-text">
        <p>The two governments agreed to expand trade and said ministers would meet again before the end of the year.</p>
        <div class="vjs-wrapper embed"><h2>Promotional video title</h2></div>
      </div></section>
      <section class="liveblog-post"><h2>Rescue work continues</h2><div class="rich-text">
        <p>Search teams continued working through debris while local authorities opened temporary shelters for displaced families.</p>
      </div></section>
    </article>`;

    const body = extractDwBody(
      html,
      { minimumCharacters: 250, minimumParagraphs: 3 },
      "https://www.dw.com/en/example/live-123",
    );

    expect(body).toContain("What you need to know");
    expect(body).toContain("Leaders announce a new trade target");
    expect(body).toContain("Rescue work continues");
    expect(body).not.toContain("Promotional video title");
  });

  it("extracts DW lazy images with captions, credits, and body positions", () => {
    const inlineTemplate = "https://static.dw.com/image/222_${formatId}.jpg";
    const html = `<html><head><meta property="og:image" content="https://static.dw.com/image/111_1200.jpg"></head><body><article>
      <header><figure>
        <picture><source type="image/jpeg" srcset="https://static.dw.com/image/111_600.jpg 600w, https://static.dw.com/image/111_1200.jpg 1200w">
          <img srcset="https://static.dw.com/image/111_599.jpg 599w" alt="Polling officials prepare ballot boxes"></picture>
        <figcaption>More than 900,000 people are eligible to vote<small class="copyright">Image: REUTERS</small></figcaption>
      </figure></header>
      <div class="rich-text">
        <p>Voters arrived early at polling stations while election workers distributed ballot papers across the capital.</p>
        <h2>When are results expected?</h2>
        <p>Officials said provisional results would be announced after regional counting centers completed their checks.</p>
        <figure class="placeholder-image master_landscape big">
          <img data-url="${inlineTemplate}" data-format="MASTER_LANDSCAPE" alt="A voter casts a ballot">
          <figcaption>The country is due to hold elections in December<small class="copyright">Image: AFP</small></figcaption>
        </figure>
        <p>Observers were deployed across the country and will issue a preliminary assessment after polls close.</p>
      </div>
      <aside class="related"><figure><img src="https://static.dw.com/image/unrelated.jpg"></figure></aside>
    </article></body></html>`;

    const images = discoverArticleImages(
      html,
      "https://www.dw.com/en/example/a-123",
      extractDwImages,
    );

    expect(images).toEqual([
      expect.objectContaining({
        sourceUrl: "https://static.dw.com/image/111_1200.jpg",
        role: "lead",
        caption: "More than 900,000 people are eligible to vote REUTERS",
        credit: "REUTERS",
      }),
      expect.objectContaining({
        sourceUrl: "https://static.dw.com/image/222_605.jpg",
        role: "content",
        afterBlock: 3,
        caption: "The country is due to hold elections in December AFP",
        credit: "AFP",
      }),
    ]);
    expect(images.map((image) => image.sourceUrl)).not.toContain("https://static.dw.com/image/unrelated.jpg");
  });

  it("keeps the first body image inline after semantic pruning when no hero exists", () => {
    const first = "Residents returned to the district after emergency crews reopened the main road on Sunday morning.";
    const last = "Local officials said repair teams would continue inspecting bridges and public buildings throughout the week.";
    const html = `<article><div class="rich-text">
      <p>${first}</p>
      <p>Brief.</p>
      <p>${first}</p>
      <p>Edited by: Example Editor</p>
      <figure><img src="/inline-report.jpg" alt="Residents walking along the reopened road"><figcaption>Residents returned on Sunday<small class="copyright">Image: REUTERS</small></figcaption></figure>
      <p>${last}</p>
    </div></article>`;
    const pageUrl = "https://www.dw.com/en/example/a-456";
    const body = extractDwBody(html, { minimumCharacters: 100, minimumParagraphs: 2 }, pageUrl);
    const images = discoverArticleImages(html, pageUrl, extractDwImages);

    expect(body?.match(/<p>/gu)).toHaveLength(2);
    expect(images).toEqual([
      expect.objectContaining({
        sourceUrl: "https://www.dw.com/inline-report.jpg",
        role: "content",
        afterBlock: 1,
      }),
    ]);
    const attached = attachExtracted(body, images);
    expect(attached.indexOf(first)).toBeLessThan(attached.indexOf('data-asset-id="dw-asset-0"'));
    expect(attached.indexOf('data-asset-id="dw-asset-0"')).toBeLessThan(attached.indexOf(last));
  });
});
