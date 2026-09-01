import { describe, expect, it } from "vitest";
import type { PageImageCandidate } from "../src/capture/page-images.js";
import { assessArticleBody, extractArticleBody, selectArticleBody } from "../src/content/body.js";
import { attachAssetsToBody } from "../src/process/article.js";
import { extractAxiosImages } from "../src/sources/axios/images.js";
import { extractAxiosBody } from "../src/sources/axios/process.js";
import { extractBloombergImages } from "../src/sources/bloomberg/images.js";
import { extractBloombergBody } from "../src/sources/bloomberg/process.js";
import { ftFetch } from "../src/sources/ft/fetch.js";
import { extractFtImages } from "../src/sources/ft/images.js";
import { classifyFtAccessOffer, extractFtBody } from "../src/sources/ft/process.js";
import { extractGuardianImages } from "../src/sources/guardian/images.js";
import { extractGuardianBody } from "../src/sources/guardian/process.js";
import { extractNprImages } from "../src/sources/npr/images.js";
import { extractNprBody } from "../src/sources/npr/process.js";
import type { CapturedAsset } from "../src/types.js";

function attachExtracted(body: string | undefined, images: PageImageCandidate[]): string {
  if (!body) throw new Error("Expected extracted body");
  const assets: CapturedAsset[] = images.map((image, index) => ({
    ...image,
    id: `asset-${index}`,
    type: "image",
    rawObject: `assets/${index}.webp`,
    mediaType: "image/webp",
    size: 1,
    sha256: String(index).padStart(64, "0"),
  }));
  return attachAssetsToBody(body, assets);
}

describe("western publisher extraction audit", () => {
  it("keeps the Guardian standfirst and owned body but not topic navigation", () => {
    const html = `<main><article>
      <figure><picture><source srcset="/hero-700.jpg 700w, /hero-1400.jpg 1400w"><img src="/hero.jpg" alt="Election night" width="700" height="450"></picture><figcaption>Election night in Reykjavík. Photograph: A Reporter/AP</figcaption></figure>
      <div data-gu-name="standfirst"><p>Well-funded no camp prevails after a closely fought national referendum.</p><ul><li><a href="/analysis">Analysis: what tipped the referendum</a></li></ul></div>
      <div data-gu-name="body">
        <p>Brief.</p>
        <p>Voters rejected the proposal after a campaign that divided the country.</p>
        <p>Voters rejected the proposal after a campaign that divided the country.</p>
        <figure><img src="/prime-minister.jpg" alt="Prime minister speaking" width="900" height="600"><figcaption>Speaking after the result. Photograph: Reporter/Reuters</figcaption></figure>
        <p>The government said it would respect the result and review its next steps.</p>
      </div>
      <div data-gu-name="tags"><ul><li><a href="/world/iceland">Iceland</a></li><li>News</li></ul></div>
      <aside><p>Recommended story that is not part of this report.</p></aside>
    </article></main>`;

    const body = extractGuardianBody(html, { minimumCharacters: 120, minimumParagraphs: 3 }, "https://www.theguardian.com/story");
    expect(body).toMatch(/^<p>Well-funded no camp/);
    expect(body).toContain("https://www.theguardian.com/analysis");
    expect(body).toContain("The government said");
    expect(body).not.toContain("Recommended story");
    expect(body).not.toContain("/world/iceland");

    const images = extractGuardianImages(html, "https://www.theguardian.com/story");
    expect(images).toEqual([
      expect.objectContaining({
        sourceUrl: "https://www.theguardian.com/hero-1400.jpg",
        role: "lead",
        caption: "Election night in Reykjavík. Photograph: A Reporter/AP",
      }),
      expect.objectContaining({
        sourceUrl: "https://www.theguardian.com/prime-minister.jpg",
        role: "content",
        afterBlock: 3,
        caption: "Speaking after the result. Photograph: Reporter/Reuters",
      }),
    ]);
    const attached = attachExtracted(body, images);
    expect(attached.indexOf('data-asset-id="asset-0"')).toBeLessThan(attached.indexOf("Well-funded no camp"));
    expect(attached.indexOf("Voters rejected the proposal")).toBeLessThan(attached.indexOf('data-asset-id="asset-1"'));
    expect(attached.indexOf('data-asset-id="asset-1"')).toBeLessThan(attached.indexOf("The government said"));
  });

  it("unwraps only Guardian word-internal spelling marks", () => {
    const html = `<main><article><div data-gu-name="body">
      <p>The home favo<s class="spelling-variant">u</s>rite held serve after a long opening game.</p>
      <p>The liveblog retained <s>an incorrect score</s> to show readers the published correction.</p>
      <p>Reporters then added another full paragraph describing the next game and the crowd response.</p>
    </div></article></main>`;

    const body = extractGuardianBody(
      html,
      { minimumCharacters: 100, minimumParagraphs: 3 },
      "https://www.theguardian.com/sport/live/example",
    )!;

    expect(body).toContain("home favourite held serve");
    expect(body).not.toContain("favo<s");
    expect(body).toContain("<s>an incorrect score</s>");
  });

  it("reads Bloomberg rich text, links, lists, photos and chart fallbacks from its story model", () => {
    const nextData = { props: { pageProps: { story: {
      lede: {
        url: "https://assets.bwbx.io/lead.webp", alt: "Lead photo", caption: "Lead caption.",
        credit: "Photographer: Lead Credit/Bloomberg", width: 2000, height: 1200,
      },
      body: { content: [
        { type: "paragraph", content: [
          { type: "text", value: "President " },
          { type: "entity", data: { link: { webUrl: "/news/articles/linked" } }, content: [{ type: "text", value: "announced a policy" }] },
          { type: "text", value: " during a detailed briefing." },
        ] },
        { type: "paragraph", content: [{ type: "text", value: "Brief." }] },
        { type: "paragraph", content: [
          { type: "text", value: "President " },
          { type: "entity", data: { link: { webUrl: "/news/articles/linked" } }, content: [{ type: "text", value: "announced a policy" }] },
          { type: "text", value: " during a detailed briefing." },
        ] },
        { type: "media", subType: "photo", data: { photo: {
          src: "https://assets.bwbx.io/body.webp", alt: "Cabinet meeting", caption: "Cabinet members met on Wednesday.", credit: "Photographer: Body Credit/Bloomberg",
        }, attachment: { width: 1800, height: 1200 } } },
        { type: "paragraph", content: [{ type: "text", value: "Officials said the plan would be reviewed again after the next economic report." }] },
        { type: "heading", content: [{ type: "text", value: "Market response" }] },
        { type: "list", subType: "unordered", content: [
          { type: "listItem", content: [{ type: "text", value: "Investors initially moved into safe-haven assets." }] },
          { type: "listItem", content: [{ type: "text", value: "The dollar later recovered some of its losses." }] },
        ] },
        { type: "media", subType: "chart", data: { chart: { fallback: "https://assets.bwbx.io/chart.png" }, attachment: {
          title: "Gold options remained measured", subtitle: "Volatility stayed below its first-quarter peak", source: "Source: Cboe, Bloomberg",
          responsiveImages: { light: { url: "https://assets.bwbx.io/chart-light.png", width: 2010, height: 1620 } },
        } } },
        { type: "paragraph", content: [{ type: "text", value: "Sign up here for the daily Markets newsletter and subscribe to the podcast." }] },
        { type: "list", content: [
          { type: "listItem", content: [
            { type: "entity", data: { link: { webUrl: "https://www.bloomberg.com/account/newsletters/markets-daily" } }, content: [{ type: "text", value: "Markets Daily" }] },
            { type: "text", value: " for the latest market news" },
          ] },
          { type: "listItem", content: [
            { type: "entity", data: { link: { webUrl: "https://www.bloomberg.com/account/newsletters/five-things" } }, content: [{ type: "text", value: "Five Things" }] },
            { type: "text", value: " to start your morning" },
          ] },
        ] },
        { type: "ad", content: [{ type: "text", value: "Advertisement" }] },
      ] },
    } } } };
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script>`;

    const body = extractBloombergBody(html, { minimumCharacters: 100, minimumParagraphs: 2 }, "https://www.bloomberg.com/story");
    expect(body).toContain('<a href="https://www.bloomberg.com/news/articles/linked"');
    expect(body).toContain("<h2>Market response</h2>");
    expect(body).toContain("<ul><li>Investors initially");
    expect(body).not.toContain("Sign up here");
    expect(body).not.toContain("Markets Daily");
    expect(body).not.toContain("Advertisement");

    const images = extractBloombergImages(html, "https://www.bloomberg.com/story");
    expect(images).toEqual([
      expect.objectContaining({ sourceUrl: "https://assets.bwbx.io/lead.webp", role: "lead", credit: "Photographer: Lead Credit/Bloomberg" }),
      expect.objectContaining({ sourceUrl: "https://assets.bwbx.io/body.webp", role: "content", afterBlock: 1, caption: "Cabinet members met on Wednesday. Photographer: Body Credit/Bloomberg" }),
      expect.objectContaining({ sourceUrl: "https://assets.bwbx.io/chart-light.png", role: "content", afterBlock: 4, credit: "Source: Cboe, Bloomberg" }),
    ]);
    const attached = attachExtracted(body, images);
    expect(attached.indexOf("detailed briefing")).toBeLessThan(attached.indexOf('data-asset-id="asset-1"'));
    expect(attached.indexOf('data-asset-id="asset-1"')).toBeLessThan(attached.indexOf("Officials said"));

    const liveblogData = { props: { pageProps: { liveblog: { posts: [{ body: { content: [
      { type: "div", content: [{ type: "text", value: "The live update reports a material development." }] },
      { type: "media", subType: "photo", data: { photo: { src: "https://assets.bwbx.io/live.webp", caption: "The scene during the live update." } } },
      { type: "div", content: [{ type: "text", value: "Officials later supplied further context." }] },
    ] } }] } } } };
    const liveblogHtml = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(liveblogData)}</script>`;
    expect(extractBloombergImages(liveblogHtml, "https://www.bloomberg.com/live")).toEqual([
      expect.objectContaining({ sourceUrl: "https://assets.bwbx.io/live.webp", role: "content", afterBlock: 1 }),
    ]);
  });

  it("uses the FT standfirst and article body while cutting share, newsletter and topic UI", () => {
    const html = `<main><article>
      <div class="article__standfirst"><p>Prime minister had faced criticism over moves to avert prison overcrowding.</p></div>
      <figure class="article__hero"><picture><source srcset="/hero-800.avif 800w, /hero-1600.avif 1600w"><img src="/hero.jpg" alt="Prime minister speaking" width="1600" height="900"></picture><figcaption>Prime minister speaking in London © Photographer/FT</figcaption></figure>
      <ul class="article__share"><li>Story title on x (opens in a new window)</li></ul>
      <div class="article__content-body">
        <div class="newsletter-signup"><p>Roula Khalaf, Editor of the FT, selects her favourite stories in this weekly newsletter.</p></div>
        <p>The government changed the release scheme after a week of criticism.</p>
        <p>Brief.</p>
        <p>The government changed the release scheme after a week of criticism.</p>
        <p>Some content could not load. Check your internet connection or browser settings.</p>
        <figure><img src="/inside.avif" alt="A prison wing" width="1200" height="800"><figcaption>A prison wing in England © Another Photographer/FT</figcaption></figure>
        <p>Officials said serious offenders would no longer qualify for automatic release.</p>
        <p>Some content could not load. Check your internet connection or browser settings.</p>
        <h2>Follow the topics in this article</h2><ul><li><a href="/uk-prisons">UK prisons</a></li></ul>
        <figure><img src="/recommendation.avif" alt="A recommendation" width="1200" height="800"><figcaption>Not part of the story</figcaption></figure>
        <h2>Comments</h2>
      </div>
    </article></main>`;

    const pageUrl = "https://www.ft.com/content/story";
    const extracted = extractFtBody(html, { minimumCharacters: 120, minimumParagraphs: 3 }, pageUrl);
    expect(typeof extracted).toBe("string");
    if (typeof extracted !== "string") throw new Error("Expected an extracted FT article body");
    const body = extracted;
    expect(classifyFtAccessOffer(body)).toBeUndefined();
    expect(body).toMatch(/^<p>Prime minister had faced criticism/);
    expect(body).toContain("serious offenders");
    expect(body).not.toContain("Roula Khalaf");
    expect(body).not.toContain("Some content could not load");
    expect(body).not.toContain("Follow the topics");
    expect(body).not.toContain("Comments");

    expect(assessArticleBody(
      html,
      ftFetch,
      { minimumCharacters: 120, minimumParagraphs: 3 },
      extractFtBody,
      pageUrl,
      "captured-page",
    )).toMatchObject({
      extractionPath: "publisher-extractor-legacy",
      completeness: "unknown",
      verdict: "accepted",
    });

    const images = extractFtImages(html, pageUrl);
    expect(images).toEqual([
      expect.objectContaining({ sourceUrl: "https://www.ft.com/hero-1600.avif", role: "lead", caption: "Prime minister speaking in London © Photographer/FT" }),
      expect.objectContaining({ sourceUrl: "https://www.ft.com/inside.avif", role: "content", afterBlock: 2, caption: "A prison wing in England © Another Photographer/FT" }),
    ]);
    const attached = attachExtracted(body, images);
    expect(attached.indexOf("The government changed")).toBeLessThan(attached.indexOf('data-asset-id="asset-1"'));
    expect(attached.indexOf('data-asset-id="asset-1"')).toBeLessThan(attached.indexOf("Officials said"));
  });

  it("rejects the persisted FT subscription-offer artifact from the 2026-08-28 delivery", () => {
    const historicalBody = `<p>FirstFT: US corporate profits surge as wages lag</p>
      <p>Try unlimited access</p>
      <p>Then $75 per month. Complete digital access to quality FT journalism on any device. Cancel anytime during your trial.</p>
      <p>Explore more offers.</p>
      <p>Essential digital access to quality FT journalism on any device. Pay a year upfront and save 20%.</p>
      <p>Complete digital access to quality FT journalism with expert analysis from industry leaders. Pay a year upfront and save 20%.</p>
      <p>Our digitised version of the FT newspaper, for easy reading on any device.</p>
      <p>Check whether you already have access via your university or organisation.</p>
      <p>Terms &amp; Conditions apply</p>
      <p>Explore our full range of subscriptions.</p>
      <p>Discover all the plans currently available in your country</p>
      <p>For multiple readers</p>
      <p>Digital access for organisations. Includes exclusive features and content.</p>`;
    const html = `<main><article><div class="article__content-body">${historicalBody}</div></article></main>`;
    const quality = { minimumCharacters: 800, minimumParagraphs: 3 };
    const firstUrl = "https://www.ft.com/content/5e6db1ad-6ea5-44db-80fd-fd7073d9e676?syn-25a6b1a6=1";
    const longerHistoricalOffer = html.replace(
      "FirstFT: US corporate profits surge as wages lag",
      "Senior German politicians call for ban on parts of far-right AfD",
    );
    const cases = [
      { html, pageUrl: firstUrl },
      {
        html: longerHistoricalOffer,
        pageUrl: "https://www.ft.com/content/593c2cde-cf0d-4dcd-a170-9cb1dc9ed896?syn-25a6b1a6=1",
      },
    ];

    for (const fixture of cases) {
      expect(classifyFtAccessOffer(fixture.html)).toEqual({
        marker: "consumer-subscription-offer",
        matchedSignals: 4,
      });
      expect(extractFtBody(fixture.html, quality, fixture.pageUrl)).toMatchObject({
        completeness: "truncated",
        evidence: {
          kind: "access-offer",
          marker: "consumer-subscription-offer",
          matchedSignals: 4,
        },
      });
      expect(assessArticleBody(
        fixture.html,
        ftFetch,
        quality,
        extractFtBody,
        fixture.pageUrl,
        "captured-page",
      )).toMatchObject({
        extractionPath: "publisher-extractor",
        completeness: "truncated",
        verdict: "rejected",
        rejectReason: "publisher-truncated",
        evidence: {
          kind: "access-offer",
          marker: "consumer-subscription-offer",
        },
      });
      expect(extractArticleBody(fixture.html, ftFetch, quality, extractFtBody, fixture.pageUrl)).toBeUndefined();
      expect(extractFtImages(fixture.html, fixture.pageUrl)).toEqual([]);
    }

    const completeDiscoveryBody = `<article>${Array.from({ length: 3 }, (_, index) => (
      `<p>${`Complete discovery paragraph ${index} contains enough reported detail to satisfy the configured source threshold. `.repeat(4)}</p>`
    )).join("")}</article>`;
    expect(extractArticleBody(completeDiscoveryBody, ftFetch, quality, extractFtBody, firstUrl)).toBeDefined();
    const selected = selectArticleBody({
      capturedPage: { html, pageUrl: firstUrl },
      discoveryBody: { html: completeDiscoveryBody, pageUrl: firstUrl },
    }, ftFetch, quality, extractFtBody);
    expect(selected.body).toBeUndefined();
    expect(selected.report).toEqual({
      attempts: [expect.objectContaining({
        origin: "captured-page",
        extractionPath: "publisher-extractor",
        completeness: "truncated",
        verdict: "rejected",
        rejectReason: "publisher-truncated",
      })],
    });
  });

  it("rejects FT Professional product copy in place of a publisher article", () => {
    const professionalOffer = `<main><article><div class="article__content-body">
      <p>Activate your 14 day complimentary access to read this article</p>
      <p>This content is from Monetary Policy Radar, a premium service available as an addition to an FT Professional subscription.</p>
      <p>What is Monetary Policy Radar?</p>
      <p>Monetary Policy Radar acts as a one stop shop for monetary policy related information, helping professionals interpret central bank signals and assess interest rate risks.</p>
      <p>Available at an additional cost to FT Professional subscribers, customers can use the full suite of product features.</p>
      <p>Structured data and analysis strengthen forecasts and benchmark them against market consensus and proprietary indicators.</p>
      <p>Exclusive access to central bankers helps customers interpret tone, language and policy leanings.</p>
      <p>Our editorial team delivers analysis that turns monetary policy and political forces into actionable product insight.</p>
      <p>This product testimonial and the surrounding marketing copy are not the requested Financial Times article.</p>
    </div></article></main>`;

    const quality = { minimumCharacters: 800, minimumParagraphs: 3 };
    const pageUrl = "https://www.ft.com/content/0d135ccd-f8cf-4178-a7d8-0a0dfbb705e8";
    expect(classifyFtAccessOffer(professionalOffer)).toEqual({
      marker: "professional-service-offer",
      matchedSignals: 2,
    });
    expect(extractFtBody(professionalOffer, quality, pageUrl)).toMatchObject({
      completeness: "truncated",
      evidence: {
        kind: "access-offer",
        marker: "professional-service-offer",
        matchedSignals: 2,
      },
    });
    expect(assessArticleBody(
      professionalOffer,
      ftFetch,
      quality,
      extractFtBody,
      pageUrl,
      "captured-page",
    )).toMatchObject({
      extractionPath: "publisher-extractor",
      completeness: "truncated",
      verdict: "rejected",
      rejectReason: "publisher-truncated",
      evidence: {
        kind: "access-offer",
        marker: "professional-service-offer",
      },
    });
    expect(extractArticleBody(professionalOffer, ftFetch, quality, extractFtBody, pageUrl)).toBeUndefined();
    expect(extractFtImages(professionalOffer, pageUrl)).toEqual([]);
  });

  it("terminally rejects production FT offers before the whole-article fallback", () => {
    const offerTail = `<h2>Explore more offers.</h2>
      <h3>Standard Digital</h3>
      <p>Essential digital access to quality FT journalism on any device. Pay a year upfront and save 20%.</p>
      <ul><li>Global news &amp; analysis</li><li>Expert opinion</li><li>FT App on Android &amp; iOS</li><li>20+ curated newsletters</li></ul>
      <h3>Premium Digital</h3>
      <p>Complete digital access to quality FT journalism with expert analysis from industry leaders. Pay a year upfront and save 20%.</p>
      <ul><li>20 monthly gift articles to share</li><li>Lex: FT's flagship investment column</li><li>FT Digital Edition: our digitised print edition</li></ul>
      <p>Check whether you already have access via your university or organisation.</p>
      <p>Terms &amp; Conditions apply</p>
      <h2>Explore our full range of subscriptions.</h2>
      <h3>For individuals</h3>
      <p>Discover all the plans currently available in your country</p>
      <h3>For multiple readers</h3>
      <p>Digital access for organisations. Includes exclusive features and content.</p>`;
    const productionCases = [
      {
        articleId: "ft:efd21a2c341e6ca713c3dc10",
        title: "Mel Stride sacked as shadow chancellor",
        url: "https://www.ft.com/content/f16c178f-b07c-4b79-a8fc-2bf4c70d43e2?syn-25a6b1a6=1",
        lead: `<h2>To read this article for free</h2><p>Once registered, you can read free articles, get newsletters, follow topics and access Alphaville.</p>
          <p>Then €69 per month. Complete digital access to quality FT journalism on any device. Cancel or change your plan anytime during your trial.</p>`,
      },
      {
        articleId: "ft:d9c5727150965ff81831904c",
        title: "Trump says US will hit Iran ‘hard’ as conflict reignites",
        url: "https://www.ft.com/content/8b09b3fc-bb61-4d9f-aac6-bcef9883fa16?syn-25a6b1a6=1",
        lead: `<h2>Try unlimited access</h2><p>Then ¥9000 per month. Complete digital access to quality FT journalism on any device. Cancel anytime during your trial.</p>`,
      },
      {
        articleId: "ft:e0539dc614fb4cbc92e77412",
        title: "Alejandro Betancourt: the man who would be Trump’s ‘viceroy’ in Venezuela",
        url: "https://www.ft.com/content/9dbf9c9a-b3e2-4701-b584-dca72b349716?syn-25a6b1a6=1",
        lead: `<h2>Try unlimited access</h2><p>Then €69 per month. Complete digital access to quality FT journalism on any device. Cancel anytime during your trial.</p>`,
      },
      {
        articleId: "ft:188c7a6fb26547ff4e97c43e",
        title: "Americans feel they have lost their agency",
        url: "https://www.ft.com/content/63e8a4f3-7c18-4ddc-b3b7-e472159a7adf?syn-25a6b1a6=1",
        lead: `<h2>Try unlimited access</h2><p>Then ¥9000 per month. Complete digital access to quality FT journalism on any device. Cancel anytime during your trial.</p>`,
      },
      {
        articleId: "ft:30cecd9e3a6d42ee8a3fa71f",
        title: "The cult $4.99 rotisserie chicken defying inflation",
        url: "https://www.ft.com/content/30ac3572-06a9-4718-8043-60b1dee50c40?syn-25a6b1a6=1",
        lead: `<h2>Try unlimited access</h2><p>Then Dkr535 per month. Complete digital access to quality FT journalism on any device. Cancel anytime during your trial.</p>`,
      },
    ];
    const quality = { minimumCharacters: 800, minimumParagraphs: 3 };

    for (const fixture of productionCases) {
      // These captures have no stable FT body container. Without the FT
      // extractor, the shared `article` selector accepts the complete offer.
      const html = `<main><article data-production-id="${fixture.articleId}">
        <blockquote>${fixture.title}</blockquote>${fixture.lead}${offerTail}
      </article></main>`;
      expect(assessArticleBody(html, ftFetch, quality, undefined, fixture.url, "captured-page")).toMatchObject({
        extractionPath: "source-selector",
        verdict: "accepted",
      });
      expect(extractFtBody(html, quality, fixture.url)).toMatchObject({
        completeness: "truncated",
        evidence: {
          kind: "access-offer",
          marker: "consumer-subscription-offer",
          location: "article",
          matchedSignals: 4,
        },
      });
      expect(assessArticleBody(
        html,
        ftFetch,
        quality,
        extractFtBody,
        fixture.url,
        "captured-page",
      )).toMatchObject({
        extractionPath: "publisher-extractor",
        completeness: "truncated",
        verdict: "rejected",
        rejectReason: "publisher-truncated",
      });
      expect(extractArticleBody(html, ftFetch, quality, extractFtBody, fixture.url)).toBeUndefined();
      expect(extractFtImages(html, fixture.url)).toEqual([]);
    }
  });

  it("rejects an FT article fallback when a tiny publisher body omits the surrounding offer", () => {
    const quality = { minimumCharacters: 800, minimumParagraphs: 3 };
    const pageUrl = "https://www.ft.com/content/f16c178f-b07c-4b79-a8fc-2bf4c70d43e2?syn-25a6b1a6=1";
    const html = `<main><article>
      <div class="article__content-body"><p>Brief unavailable article preview.</p></div>
      <section class="subscription-promo">
        <h2>Try unlimited access</h2>
        <p>Then €69 per month. Complete digital access to quality FT journalism on any device. Cancel anytime during your trial.</p>
        <p>${"Subscription benefits and product details shown instead of the requested report. ".repeat(12)}</p>
        <h2>Explore our full range of subscriptions.</h2>
        <p>Discover all the plans currently available in your country</p>
        <p>Digital access for organisations. Includes exclusive features and content.</p>
      </section>
    </article></main>`;

    expect(extractFtBody(html, quality, pageUrl)).toMatchObject({
      completeness: "truncated",
      evidence: {
        kind: "access-offer",
        marker: "consumer-subscription-offer",
        location: "article",
        matchedSignals: 4,
      },
    });
    expect(assessArticleBody(html, ftFetch, quality, undefined, pageUrl, "captured-page")).toMatchObject({
      extractionPath: "source-selector",
      verdict: "accepted",
    });
    expect(assessArticleBody(html, ftFetch, quality, extractFtBody, pageUrl, "captured-page")).toMatchObject({
      extractionPath: "publisher-extractor",
      completeness: "truncated",
      verdict: "rejected",
      rejectReason: "publisher-truncated",
    });
    expect(extractArticleBody(html, ftFetch, quality, extractFtBody, pageUrl)).toBeUndefined();
  });

  it("rejects an FT offer split across the containers combined by the shared source selector", () => {
    const quality = { minimumCharacters: 800, minimumParagraphs: 3 };
    const pageUrl = "https://www.ft.com/content/split-access-offer";
    const benefits = "Subscriber benefits and product details are displayed instead of the requested report. ".repeat(8);
    const html = `<main>
      <div data-content-id="offer-lead">
        <h2>Try unlimited access</h2>
        <p>Complete digital access to quality FT journalism on any device. ${benefits}</p>
      </div>
      <div data-content-id="offer-individuals">
        <h2>Explore our full range of subscriptions.</h2>
        <p>Discover all the plans currently available in your country. ${benefits}</p>
      </div>
      <div data-content-id="offer-organisations">
        <p>Digital access for organisations. Includes exclusive features and content. ${benefits}</p>
      </div>
    </main>`;

    expect(assessArticleBody(html, ftFetch, quality, undefined, pageUrl, "captured-page")).toMatchObject({
      extractionPath: "source-selector",
      verdict: "accepted",
    });
    expect(extractFtBody(html, quality, pageUrl)).toMatchObject({
      completeness: "truncated",
      evidence: {
        kind: "access-offer",
        marker: "consumer-subscription-offer",
        location: "[data-content-id]",
        matchedSignals: 4,
      },
    });
    expect(assessArticleBody(html, ftFetch, quality, extractFtBody, pageUrl, "captured-page")).toMatchObject({
      extractionPath: "publisher-extractor",
      completeness: "truncated",
      verdict: "rejected",
      rejectReason: "publisher-truncated",
    });
  });

  it("keeps the shared fallback available when no FT publisher body structure matches", () => {
    const quality = { minimumCharacters: 300, minimumParagraphs: 3 };
    const pageUrl = "https://www.ft.com/content/nonstandard-story";
    const html = `<main><article>${Array.from({ length: 3 }, (_, index) => (
      `<p>Reported fallback paragraph ${index} explains the policy decision, its consequences and the response from affected organisations in enough detail for readers.</p>`
    )).join("")}</article></main>`;

    expect(extractFtBody(html, quality, pageUrl)).toBeUndefined();
    expect(assessArticleBody(
      html,
      ftFetch,
      quality,
      extractFtBody,
      pageUrl,
      "captured-page",
    )).toMatchObject({
      extractionPath: "source-selector",
      completeness: "unknown",
      verdict: "accepted",
    });

    const offerOutsideSharedFallback = html.replace("</article></main>", `<aside>
        <p>Complete digital access to quality FT journalism on any device.</p>
        <p>Explore our full range of subscriptions.</p>
        <p>Discover all the plans currently available in your country</p>
        <p>Digital access for organisations. Includes exclusive features and content.</p>
      </aside></article></main>`);
    expect(extractFtBody(offerOutsideSharedFallback, quality, pageUrl)).toBeUndefined();
    const fallback = assessArticleBody(
      offerOutsideSharedFallback,
      ftFetch,
      quality,
      extractFtBody,
      pageUrl,
      "captured-page",
    );
    expect(fallback).toMatchObject({
      extractionPath: "source-selector",
      verdict: "accepted",
    });
    expect(fallback.body).not.toContain("Explore our full range of subscriptions");
  });

  it("extracts Axios Smart Brevity blocks and separators without byline and preferred-source UI", () => {
    const html = `<main><article>
      <ul class="author-list"><li><a href="/authors/reporter">Reporter Name</a></li></ul>
      <p class="preferred-source">Add Axios as your preferred source to see more of our stories on Google.</p>
      <div class="gtm-story-text">
        <figure><picture><source srcset="/grocery-800.webp 800w, /grocery-1600.webp 1600w"><img src="/grocery.jpg" alt="Groceries on shelves" width="1600" height="900"></picture><figcaption>Illustration: Artist/Axios</figcaption></figure>
        <p>America's grocery squeeze has been felt most painfully in several expensive categories.</p>
        <ul><li><strong>Why it matters: </strong>The next price shock could hit much harder and wider.</li></ul>
        <hr>
        <p><strong>The big picture: </strong>Pressures are building throughout the global supply chain.</p>
        <p>Brief.</p>
        <p><strong>The big picture: </strong>Pressures are building throughout the global supply chain.</p>
        <figure><img src="/farm.jpg" alt="A farm field" width="1400" height="900"><figcaption>Photo: Farmer/Axios</figcaption></figure>
        <p><strong>The bottom line: </strong>Consumers are likely to feel the accumulated pressure over time.</p>
      </div>
    </article></main>`;
    const pageUrl = "https://www.axios.com/2026/08/30/story";
    const body = extractAxiosBody(html, { minimumCharacters: 100, minimumParagraphs: 3 }, pageUrl);
    expect(body).toContain("America's grocery squeeze");
    expect(body).toContain("<hr>");
    expect(body).not.toContain("Reporter Name");
    expect(body).not.toContain("preferred source");
    const images = extractAxiosImages(html, pageUrl);
    expect(images).toEqual([
      expect.objectContaining({ sourceUrl: "https://www.axios.com/grocery-1600.webp", role: "lead", caption: "Illustration: Artist/Axios" }),
      expect.objectContaining({ sourceUrl: "https://www.axios.com/farm.jpg", role: "content", afterBlock: 3, caption: "Photo: Farmer/Axios" }),
    ]);
    const attached = attachExtracted(body, images);
    expect(attached.indexOf("The big picture")).toBeLessThan(attached.indexOf('data-asset-id="asset-1"'));
    expect(attached.indexOf('data-asset-id="asset-1"')).toBeLessThan(attached.indexOf("The bottom line"));

    const feedBody = `<p>First complete feed paragraph contains the report introduction.</p><hr><p>Second complete feed paragraph adds context.</p><p>Third complete feed paragraph supplies the conclusion.</p>`;
    expect(extractAxiosBody(feedBody, { minimumCharacters: 100, minimumParagraphs: 3 }, pageUrl)).toContain("<hr>");
  });

  it("keeps only NPR storytext prose and story-owned image buckets", () => {
    const image = (name: string, caption: string) => `<div class="bucketwrap image x-large">
      <div class="imagewrap" style="--source-width: 2400; --source-height: 1600"><picture><source type="image/webp" srcset="/${name}-800.webp 800w, /${name}-1600.webp 1600w"><img src="/${name}.jpg" alt="${caption}"></picture></div>
      <div class="credit-caption"><div class="caption-wrap"><div class="caption" aria-label="Image caption"><p>${caption}<b class="credit" aria-label="Image credit">Photographer for NPR</b><b class="hide-caption">hide caption</b></p></div></div></div>
    </div>`;
    const html = `<main><article class="story"><h3><a href="/sections/business">Business</a></h3>
      <div id="storytext" class="storytext">
        ${image("lead", "The lead photograph.")}
        <p>The first article paragraph explains the reported event in sufficient detail.</p>
        <aside class="ad-wrap">Sponsor Message</aside>
        <div class="bucketwrap internallink"><img src="/unrelated.jpg" alt="Unrelated recommendation"><p>Another NPR story</p></div>
        <h3 class="edTag">What happens next</h3>
        <section><p>Brief.</p><p>The first article paragraph explains the reported event in sufficient detail.</p>
        ${image("second", "A second photograph.")}
        <p>The final article paragraph describes what readers should expect next.</p></section>
        <p>A further paragraph records the response from the organization named in the report.</p>
        <p>Another paragraph supplies regional context that readers need to understand the story.</p>
        <p>The closing paragraph explains when officials expect to provide their next update.</p>
      </div>
      <p><strong>NPR does not offer or accept money for coverage or interviews.</strong></p>
      <ul class="tags"><li><a href="/tags/example">Example topic</a></li></ul>
    </article></main>`;
    const pageUrl = "https://www.npr.org/2026/08/30/story";
    const body = extractNprBody(html, { minimumCharacters: 100, minimumParagraphs: 5 }, pageUrl);
    expect(body).toContain("first article paragraph");
    expect(body).toContain("<h3>What happens next</h3>");
    expect(body).not.toContain("Sponsor Message");
    expect(body).not.toContain("Another NPR story");
    expect(body).not.toContain("does not offer or accept money");
    expect(body).not.toContain("Example topic");

    const images = extractNprImages(html, pageUrl);
    expect(images).toEqual([
      expect.objectContaining({ sourceUrl: "https://www.npr.org/lead-1600.webp", role: "lead", caption: "The lead photograph. Photographer for NPR", credit: "Photographer for NPR" }),
      expect.objectContaining({ sourceUrl: "https://www.npr.org/second-1600.webp", role: "content", afterBlock: 2, caption: "A second photograph. Photographer for NPR" }),
    ]);
    const attached = attachExtracted(body, images);
    expect(attached.indexOf("What happens next")).toBeLessThan(attached.indexOf('data-asset-id="asset-1"'));
    expect(attached.indexOf('data-asset-id="asset-1"')).toBeLessThan(attached.indexOf("The final article paragraph"));
  });
});
