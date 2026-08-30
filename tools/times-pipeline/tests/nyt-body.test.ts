import { describe, expect, it } from "vitest";
import { extractNytBody } from "../src/sources/nyt/process.js";

const pageUrl = "https://www.nytimes.com/2026/08/30/world/canada/lake-ontario-america-google-maps.html";

describe("NYT body extraction", () => {
  it("combines the standfirst and every articleBody section while excluding captions and recirculation", () => {
    const html = `
      <main>
        <p id="article-summary">Users in the United States will see the new label, following President Trump's executive order last week.</p>
        <a href="/by/matina-stevis-gridneff">By Matina Stevis-Gridneff</a>
        <section name="articleBody">
          <p>The change appeared on Google Maps for users across the United States on Monday morning.</p>
          <figure>
            <img src="lake.jpg">
            <figcaption><p>Lake Ontario in Toronto. Eugen Sakhnenko for The New York Times</p></figcaption>
          </figure>
          <p>Canadian officials said the lake's Indigenous name long predates either modern country.</p>
        </section>
        <section name="articleBody">
          <p><a href="/interactive/2026/canada.html">Canadians have rallied behind Mr. Carney</a>, but are bracing for the economic impact.</p>
          <p>Matina Stevis-Gridneff is the Canada bureau chief for The Times, leading coverage of the country.</p>
          <div data-testid="story-recirculation">
            <p>This recommendation must never become part of the article body.</p>
          </div>
          <h2>Related Content</h2>
          <p>This card comes after the related-content heading and must be removed.</p>
        </section>
        <section name="articleBody">
          <p>This section occurs after recirculation and must not be appended.</p>
        </section>
      </main>`;

    const body = extractNytBody(html, { minimumCharacters: 100, minimumParagraphs: 3 }, pageUrl);

    expect(body).toContain("Users in the United States will see the new label");
    expect(body).toContain("The change appeared on Google Maps");
    expect(body).toContain("Canadian officials said");
    expect(body).toContain("https://www.nytimes.com/interactive/2026/canada.html");
    expect(body).toContain("<a href=\"https://www.nytimes.com/by/matina-stevis-gridneff\"");
    expect(body).not.toContain("Lake Ontario in Toronto");
    expect(body).not.toContain("recommendation must never");
    expect(body).not.toContain("Related Content");
    expect(body).not.toContain("after recirculation");
  });

  it("uses the document description when the visible article summary is absent", () => {
    const html = `
      <head>
        <meta name="description" content="A descriptive standfirst supplied by The New York Times for this report.">
      </head>
      <body>
        <section name="articleBody">
          <p>The first substantial paragraph contains enough detail to be retained by the extractor.</p>
          <p>The second substantial paragraph gives readers important context about the reported change.</p>
          <p>The third substantial paragraph completes the short fixture used by this focused test.</p>
        </section>
      </body>`;

    const body = extractNytBody(html, { minimumCharacters: 100, minimumParagraphs: 3 }, pageUrl);

    expect(body).toMatch(/^<p>A descriptive standfirst supplied/);
    expect(body).toContain("The third substantial paragraph");
  });

  it("returns undefined without an NYT articleBody section so generic fallback remains available", () => {
    expect(extractNytBody(
      "<article><p>A generic article is not claimed by the NYT adapter.</p></article>",
      { minimumCharacters: 20, minimumParagraphs: 1 },
      pageUrl,
    )).toBeUndefined();
  });
});
