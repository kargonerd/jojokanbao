import { describe, expect, it } from "vitest";
import { discoverArticleImages } from "../src/capture/page-images.js";
import { extractArticleBody } from "../src/content/body.js";
import { attachAssetsToBody } from "../src/process/article.js";
import { agenciaBrasilFetch } from "../src/sources/agencia-brasil/fetch.js";
import { extractAgenciaBrasilImages } from "../src/sources/agencia-brasil/images.js";
import { extractAgenciaBrasilBody } from "../src/sources/agencia-brasil/process.js";
import type { CapturedAsset } from "../src/types.js";

describe("Agência Brasil article images", () => {
  it("uses only Drupal's publisher body field and preserves article links", () => {
    const html = `<article><div class="node__content"><div class="field--name-body">
      <p>Officials met in Brasília to <a href="/politica/topic">discuss the policy</a> and publish its implementation timetable.</p>
      <p>The ministry said consultations with state and municipal governments would continue throughout the month.</p>
    </div><section class="related-content"><p>This unrelated recommendation is long enough to contaminate a generic node extraction.</p></section></div></article>`;
    const body = extractArticleBody(
      html,
      agenciaBrasilFetch,
      { minimumCharacters: 100, minimumParagraphs: 2 },
      extractAgenciaBrasilBody,
      "https://agenciabrasil.ebc.com.br/politica/noticia/2026-08/example",
    );

    expect(body).toContain('href="https://agenciabrasil.ebc.com.br/politica/topic"');
    expect(body).toContain("consultations with state");
    expect(body).not.toContain("unrelated recommendation");
  });

  it("archives only the lead and images inside Drupal's article body field", () => {
    const html = `<html><head>
      <meta property="og:image" content="https://images.ebc.com.br/lead.jpg">
      <meta property="og:image:alt" content="Government officials meet in Brasília">
    </head><body><article><div class="node__content">
      <div class="field field--name-body">
        <p>Officials met in Brasília to discuss the policy and publish the timetable for implementation across the country.</p>
        <figure><picture><img src="/placeholder.jpg" srcset="/inline-640.jpg 640w, /inline-1600.jpg 1600w" width="1600" height="900" alt="Officials at the meeting"></picture>
          <figcaption>Officials present the timetable during the meeting.</figcaption>
        </figure>
        <p>The ministry said the next report would be released after consultations with state and municipal governments.</p>
      </div>
      <section class="related-content"><img src="https://images.ebc.com.br/unrelated-election.jpg" width="1200" height="800"></section>
      <img src="https://metrics.ebc.com.br/tracking.gif" width="1" height="1">
    </div></article></body></html>`;

    const images = discoverArticleImages(
      html,
      "https://agenciabrasil.ebc.com.br/politica/noticia/2026-08/example",
      extractAgenciaBrasilImages,
    );

    expect(images).toEqual([
      expect.objectContaining({
        sourceUrl: "https://images.ebc.com.br/lead.jpg",
        role: "lead",
        alt: "Government officials meet in Brasília",
      }),
      expect.objectContaining({
        sourceUrl: "https://agenciabrasil.ebc.com.br/inline-1600.jpg",
        role: "content",
        afterBlock: 1,
        caption: "Officials present the timetable during the meeting.",
      }),
    ]);
    expect(images.map((image) => image.sourceUrl)).not.toContain("https://images.ebc.com.br/unrelated-election.jpg");
    expect(images.map((image) => image.sourceUrl)).not.toContain("https://metrics.ebc.com.br/tracking.gif");
  });

  it("mounts a body image after the preceding semantic block", () => {
    const pageUrl = "https://agenciabrasil.ebc.com.br/politica/noticia/2026-08/example";
    const html = `<article><div class="field--name-body">
      <p>The first complete paragraph appears before a nested list in the published report.</p>
      <ul><li><p>The nested list paragraph remains one top-level list block in the archive.</p></li></ul>
      <figure><img src="/positioned.jpg" width="1200" height="800"><figcaption>Officials review the report.</figcaption></figure>
      <p>The final complete paragraph appears after the publisher photograph.</p>
    </div></article>`;
    const body = extractAgenciaBrasilBody(html, { minimumCharacters: 100, minimumParagraphs: 2 }, pageUrl)!;
    const candidate = extractAgenciaBrasilImages(html, pageUrl)[0]!;
    const asset: CapturedAsset = {
      ...candidate,
      id: "agencia-positioned",
      type: "image",
      rawObject: "raw/agencia/assets/positioned.jpg",
      mediaType: "image/jpeg",
      size: 1,
      sha256: "agencia-positioned",
    };
    const attached = attachAssetsToBody(body, [asset]);

    expect(candidate.afterBlock).toBe(2);
    expect(attached.indexOf("nested list paragraph")).toBeLessThan(attached.indexOf('data-asset-id="agencia-positioned"'));
    expect(attached.indexOf('data-asset-id="agencia-positioned"')).toBeLessThan(attached.indexOf("final complete paragraph"));
  });

  it("uses the source adapter's alternate-template extraction without Drupal's body field", () => {
    const html = `<meta property="og:image" content="/lead.jpg"><div class="node__content">
      <p>The alternate template keeps its publisher paragraph and an inline photograph in the node content.</p>
      <figure><img src="/inline.jpg" width="1200" height="800"></figure>
    </div>`;
    const images = discoverArticleImages(
      html,
      "https://agenciabrasil.ebc.com.br/example",
      extractAgenciaBrasilImages,
    );

    expect(images.map((image) => image.sourceUrl)).toEqual([
      "https://agenciabrasil.ebc.com.br/lead.jpg",
      "https://agenciabrasil.ebc.com.br/inline.jpg",
    ]);
  });
});
