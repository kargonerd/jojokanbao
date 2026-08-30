import { describe, expect, it } from "vitest";
import type { PageImageCandidate } from "../src/capture/page-images.js";
import { attachAssetsToBody } from "../src/process/article.js";
import { extractAxiosImages } from "../src/sources/axios/images.js";
import { extractAxiosBody } from "../src/sources/axios/process.js";
import { extractBloombergImages } from "../src/sources/bloomberg/images.js";
import { extractBloombergBody } from "../src/sources/bloomberg/process.js";
import { extractFtImages } from "../src/sources/ft/images.js";
import { extractFtBody } from "../src/sources/ft/process.js";
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

    const body = extractFtBody(html, { minimumCharacters: 120, minimumParagraphs: 3 }, "https://www.ft.com/content/story");
    expect(body).toMatch(/^<p>Prime minister had faced criticism/);
    expect(body).toContain("serious offenders");
    expect(body).not.toContain("Roula Khalaf");
    expect(body).not.toContain("Some content could not load");
    expect(body).not.toContain("Follow the topics");
    expect(body).not.toContain("Comments");

    const images = extractFtImages(html, "https://www.ft.com/content/story");
    expect(images).toEqual([
      expect.objectContaining({ sourceUrl: "https://www.ft.com/hero-1600.avif", role: "lead", caption: "Prime minister speaking in London © Photographer/FT" }),
      expect.objectContaining({ sourceUrl: "https://www.ft.com/inside.avif", role: "content", afterBlock: 2, caption: "A prison wing in England © Another Photographer/FT" }),
    ]);
    const attached = attachExtracted(body, images);
    expect(attached.indexOf("The government changed")).toBeLessThan(attached.indexOf('data-asset-id="asset-1"'));
    expect(attached.indexOf('data-asset-id="asset-1"')).toBeLessThan(attached.indexOf("Officials said"));
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
