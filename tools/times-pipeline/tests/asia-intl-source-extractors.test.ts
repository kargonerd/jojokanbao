import { describe, expect, it } from "vitest";
import { discoverArticleImages, type PageImageCandidate } from "../src/capture/page-images.js";
import { extractArticleBody } from "../src/content/body.js";
import { attachAssetsToBody } from "../src/process/article.js";
import { extractAlJazeeraImages } from "../src/sources/aljazeera/images.js";
import { extractAlJazeeraBody } from "../src/sources/aljazeera/process.js";
import { extractCnaImages } from "../src/sources/cna/images.js";
import { cnaFetch } from "../src/sources/cna/fetch.js";
import { extractCnaBody } from "../src/sources/cna/process.js";
import { extractFocusTaiwanImages } from "../src/sources/focus-taiwan/images.js";
import { extractFocusTaiwanBody } from "../src/sources/focus-taiwan/process.js";
import { extractNikkeiImages } from "../src/sources/nikkei/images.js";
import { extractNikkeiFreeArticleBody } from "../src/sources/nikkei/process.js";
import { extractReutersImages } from "../src/sources/reuters/images.js";
import { extractReutersBody } from "../src/sources/reuters/process.js";
import { extractScmpImages } from "../src/sources/scmp/images.js";
import { extractScmpBody } from "../src/sources/scmp/process.js";
import type { CapturedAsset } from "../src/types.js";

const quality = { minimumCharacters: 100, minimumParagraphs: 2 };

function capturedAsset(id: string, candidate: PageImageCandidate): CapturedAsset {
  return {
    ...candidate,
    id,
    type: "image",
    rawObject: `raw/test/${id}.jpg`,
    mediaType: "image/jpeg",
    size: 1,
    sha256: id,
  };
}

describe("Asia and international publisher extractors", () => {
  it("keeps Al Jazeera editorial blocks while excluding recommendations and preserving image positions", () => {
    const html = `<main>
      <figure class="article-featured-image"><picture><img src="/lead.jpg" alt="Lead image"></picture><figcaption>Lead caption</figcaption></figure>
      <div class="wysiwyg">
        <p>Opening paragraph with a <a href="/news/topic">publisher link</a> and enough editorial context for extraction.</p>
        <p><img src="/chart.png" alt="Publisher chart"></p>
        <section class="more-on"><h2>Recommended Stories</h2><p><a href="/recommended">Unrelated recommendation</a></p></section>
        <h2>What happened?</h2>
        <p>The second reported paragraph explains the event with enough supporting detail for readers.</p>
        <figure><img src="/inline.jpg" alt="Inline image"><figcaption>Inline caption</figcaption></figure>
        <p>The final paragraph follows the inline photograph in the publisher's original order.</p>
      </div>
    </main>`;
    const pageUrl = "https://www.aljazeera.com/news/example";

    const body = extractAlJazeeraBody(html, quality, pageUrl);
    const images = extractAlJazeeraImages(html, pageUrl);

    expect(body).toContain('href="https://www.aljazeera.com/news/topic"');
    expect(body).toContain("What happened?");
    expect(body).not.toContain("Recommended Stories");
    expect(body).not.toContain("Unrelated recommendation");
    expect(images).toMatchObject([
      { sourceUrl: "https://www.aljazeera.com/lead.jpg", role: "lead", caption: "Lead caption" },
      { sourceUrl: "https://www.aljazeera.com/chart.png", role: "content", afterBlock: 1, alt: "Publisher chart" },
      { sourceUrl: "https://www.aljazeera.com/inline.jpg", role: "content", afterBlock: 3, caption: "Inline caption" },
    ]);
  });

  it("places an Al Jazeera image after every expanded live-list item", () => {
    const html = `<main data-component="live-blog"><div class="wysiwyg wysiwyg--all-content">
      <p>An opening report paragraph establishes the context before the live updates begin.</p>
      <ul>
        <li>The first live update contains enough editorial detail to remain a semantic paragraph.</li>
        <li>The second live update follows it as a separate paragraph in the archived article.</li>
      </ul>
      <figure><img src="/after-list.jpg" alt="After list"><figcaption>After-list caption</figcaption></figure>
      <p>The report continues after the photograph with a final source paragraph.</p>
    </div></main>`;
    const pageUrl = "https://www.aljazeera.com/news/live/example";

    const body = extractAlJazeeraBody(html, quality, pageUrl);
    const image = extractAlJazeeraImages(html, pageUrl)[0];

    expect(body).toBeDefined();
    expect(image).toMatchObject({ afterBlock: 3, caption: "After-list caption" });
    const archived = attachAssetsToBody(body!, [capturedAsset("after-list", image!)]);
    expect(archived.indexOf("The second live update")).toBeLessThan(archived.indexOf('data-asset-id="after-list"'));
    expect(archived.indexOf('data-asset-id="after-list"')).toBeLessThan(archived.indexOf("The report continues"));
  });

  it("uses a global body index across multiple authoritative Al Jazeera containers", () => {
    const html = `<main data-component="live-blog">
      <header class="compact-featured-area"><div class="wysiwyg-content"><div class="wysiwyg wysiwyg--all-content">
        <p>The first story container supplies the opening paragraph of this live report.</p>
        <p>A second introductory paragraph completes the publisher summary before updates.</p>
      </div></div></header>
      <article data-component="live-blog-post"><div class="wysiwyg">
        <p>The next update belongs to a second publisher-owned story container.</p>
        <figure><img src="/second-container.jpg"><figcaption>Second-container caption</figcaption></figure>
        <p>The live report continues after the photograph in that second container.</p>
      </div></article>
    </main>`;
    const pageUrl = "https://www.aljazeera.com/news/liveblog/example";

    const body = extractAlJazeeraBody(html, quality, pageUrl);
    const image = extractAlJazeeraImages(html, pageUrl)[0];

    expect(body).toBeDefined();
    expect(image).toMatchObject({ afterBlock: 3, caption: "Second-container caption" });
    const archived = attachAssetsToBody(body!, [capturedAsset("second-container", image!)]);
    expect(archived.indexOf("The next update belongs")).toBeLessThan(archived.indexOf('data-asset-id="second-container"'));
    expect(archived.indexOf('data-asset-id="second-container"')).toBeLessThan(archived.indexOf("The live report continues"));
  });

  it("rejects Al Jazeera error, access-gate and non-story wysiwyg modules", () => {
    const paragraph = (label: string) => `<p>${label}: ${"This interface message is not publisher reporting and must not pass the short-story threshold. ".repeat(2)}</p>`;
    const modules = [
      `<header><div class="wysiwyg wysiwyg--all-content">${paragraph("Header one")}${paragraph("Header two")}${paragraph("Header three")}</div></header>`,
      `<main><section data-component="access-gate"><div class="wysiwyg wysiwyg--all-content">${paragraph("Access one")}${paragraph("Access two")}${paragraph("Access three")}</div></section></main>`,
      `<main><section data-component="error-page"><div class="wysiwyg wysiwyg--all-content">${paragraph("Error one")}${paragraph("Error two")}${paragraph("Error three")}</div></section></main>`,
      `<main><section class="generic-page-module"><div class="wysiwyg">${paragraph("Module one")}${paragraph("Module two")}${paragraph("Module three")}</div></section></main>`,
    ];

    for (const html of modules) {
      expect(extractAlJazeeraBody(html, { minimumCharacters: 1_000, minimumParagraphs: 5 })).toBeUndefined();
    }
  });

  it("reads Nikkei's free article payload, subhead, links, lead caption and inline positions", () => {
    const body = `<html><body><div>
      <p>First Nikkei paragraph has a <a href="/business/technology/ai">linked topic</a> and substantial reported context.</p>
      <div class="article__image"><img full="https://img.example/inline.png" width="770"></div>
      <p>Second Nikkei paragraph follows the chart and completes the freely accessible report.</p>
    </div></body></html>`;
    const data = {
      props: { pageProps: { data: {
        subhead: "A publisher standfirst outside the article body",
        image: { name: "Lead alt", imageUrl: "https://img.example/lead.jpg", fullCaption: "Lead caption © Reuters" },
        body,
      } } },
    };
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      "@type": "NewsArticle",
      isAccessibleForFree: true,
    })}</script></head><body>
      <div class="NewsArticleHeaderImage_test"><img src="https://img.example/lead.jpg" alt="Lead alt" width="780"></div>
      <script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>
    </body></html>`;

    const extracted = extractNikkeiFreeArticleBody(html, quality, "https://asia.nikkei.com/example");
    const images = extractNikkeiImages(html, "https://asia.nikkei.com/example");

    expect(extracted).toContain("A publisher standfirst outside the article body");
    expect(extracted).toContain('href="https://asia.nikkei.com/business/technology/ai"');
    expect(images[0]).toMatchObject({ role: "lead", caption: "Lead caption © Reuters", width: 780 });
    expect(images[1]).toMatchObject({ role: "content", afterBlock: 2, width: 770 });
  });

  it("marks Reuters Fusion galleries as one carousel without using cropped social images", () => {
    const gallery = [1, 2, 3].map((order) => ({
      type: "image",
      resizer_url: `https://www.reuters.com/resizer/photo-${order}.jpg`,
      width: 3000,
      height: 2000,
      caption: `Reuters caption ${order}`,
    }));
    const fusion = { result: {
      dateline: ["LONDON, Aug 30 (Reuters)"],
      content_elements: [
        { type: "paragraph", content: "Opening Reuters paragraph with enough reported context for extraction." },
        { type: "list", items: [{ content: "First reported bullet" }, { content: "Second reported bullet" }] },
        { type: "quote", content: "A directly attributed quotation from the report." },
      ],
      related_content: { galleries: [{ content_elements: gallery }] },
    } };
    const html = `<meta property="og:image" content="https://www.reuters.com/cropped.jpg"><script id="fusion-metadata">Fusion.globalContent=${JSON.stringify(fusion)};Fusion.contentCache={};</script>`;

    const images = extractReutersImages(html);
    const body = extractReutersBody(html, quality, "https://www.reuters.com/example");

    expect(body).toContain("LONDON, Aug 30 (Reuters) - Opening Reuters paragraph");
    expect(body).toContain("<li>First reported bullet</li>");
    expect(body).toContain("<blockquote>A directly attributed quotation from the report.</blockquote>");
    expect(images).toHaveLength(3);
    expect(images.map((image) => image.presentation)).toEqual([
      { type: "carousel", id: "reuters-primary-gallery", order: 0, total: 3 },
      { type: "carousel", id: "reuters-primary-gallery", order: 1, total: 3 },
      { type: "carousel", id: "reuters-primary-gallery", order: 2, total: 3 },
    ]);
    expect(images.some((image) => image.sourceUrl.includes("cropped.jpg"))).toBe(false);
  });

  it("uses SCMP structured article data for complete body, links, leading carousel and inline captions", () => {
    const article = {
      subHeadline: { text: "Publisher standfirst kept ahead of the report" },
      images: [{ type: "leading", url: "https://cdn.scmp.test/lead.jpg", title: "Lead caption", width: 1200, height: 800 }],
      leadingSlides: [{ url: "https://cdn.scmp.test/slide-2.jpg", title: "Second slide caption" }],
      body: {
        text: "First paragraph\nSecond paragraph",
        json: [
          { type: "p", children: [{ type: "text", data: "First paragraph with " }, { type: "a", attribs: { href: "/news/topic" }, children: [{ type: "text", data: "a source link" }] }] },
          { type: "inline-ad-slot", attribs: { tag: "0" } },
          { type: "div", children: [
            { type: "p", children: [{ type: "text", data: "A nested paragraph appears before the inline photograph in the publisher wrapper." }] },
            { type: "img", attribs: { src: "https://cdn.scmp.test/inline.jpg", alt: "Inline photo caption", width: "2000", height: "1333" } },
            { type: "p", children: [{ type: "text", data: "A second nested paragraph follows the photograph inside that same wrapper." }] },
          ] },
          { type: "p", children: [{ type: "text", data: "The final paragraph completes the report with substantial supporting context." }] },
          { type: "inline-plus-widget" },
        ],
      },
      moreOnThisArticles: [{ title: "Unrelated recommendation" }],
    };
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: { payload: { json: { data: { article } } } } },
    })}</script>`;

    const body = extractScmpBody(html, quality, "https://www.scmp.com/example");
    const images = extractScmpImages(html, "https://www.scmp.com/example");

    expect(body).toContain("Publisher standfirst kept ahead of the report");
    expect(body).toContain('href="https://www.scmp.com/news/topic"');
    expect(body).not.toContain("Unrelated recommendation");
    expect(images).toMatchObject([
      { role: "lead", caption: "Lead caption", presentation: { type: "carousel", order: 0, total: 2 } },
      { role: "content", afterBlock: 0, caption: "Second slide caption", presentation: { type: "carousel", order: 1, total: 2 } },
      { role: "content", afterBlock: 3, caption: "Inline photo caption", width: 2000, height: 1333 },
    ]);
  });

  it("places an SCMP wrapper image between its recursively rendered sibling blocks", () => {
    const article = {
      subHeadline: { text: "Publisher standfirst is the first archived semantic block" },
      body: { json: [{ type: "div", children: [
        { type: "p", children: [{ type: "text", data: "The nested paragraph before the photograph contains the opening report detail." }] },
        { type: "img", attribs: { src: "https://cdn.scmp.test/wrapper-inline.jpg", alt: "Wrapper caption" } },
        { type: "p", children: [{ type: "text", data: "The nested paragraph after the photograph continues the publisher report." }] },
      ] }] },
    };
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: { payload: { json: { data: { article } } } } },
    })}</script>`;
    const pageUrl = "https://www.scmp.com/news/example";

    const body = extractScmpBody(html, quality, pageUrl);
    const image = extractScmpImages(html, pageUrl)[0];

    expect(body).toBeDefined();
    expect(image).toMatchObject({ afterBlock: 2, caption: "Wrapper caption" });
    const archived = attachAssetsToBody(body!, [capturedAsset("wrapper-inline", image!)]);
    expect(archived.indexOf("before the photograph")).toBeLessThan(archived.indexOf('data-asset-id="wrapper-inline"'));
    expect(archived.indexOf('data-asset-id="wrapper-inline"')).toBeLessThan(archived.indexOf("after the photograph"));
  });

  it("keeps Focus Taiwan's author line but removes Enditem and archives every caption at source position", () => {
    const html = `<div class="PrimarySide"><div class="FullPic"><figure><picture style="--aspect-ratio: 1200 / 800"><img src="/lead.jpg" alt="Lead alt"></picture><figcaption>Lead caption</figcaption></figure></div>
      <div class="paragraph">
        <p>Opening Focus Taiwan paragraph has enough reported context for article extraction.</p>
        <div class="jsAdSlot MbAdBox">Advertisement</div>
        <p>A second paragraph contains a <a href="/politics/topic">publisher topic link</a> and more detail.</p>
        <div class="media"><figure><picture style="--aspect-ratio: 1000 / 700"><source data-srcset="/inline-small.jpg 500w, /inline.jpg 1000w"><img alt="Inline alt"></picture><figcaption>Inline caption</figcaption></figure></div>
        <p>The final report paragraph follows the photograph in source order.</p>
        <div class="author"><p>(By Reporter One and Reporter Two)</p><p>Enditem/AW</p></div>
      </div>
    </div>`;
    const pageUrl = "https://focustaiwan.tw/politics/202608300001";

    const body = extractFocusTaiwanBody(html, quality, pageUrl);
    const images = extractFocusTaiwanImages(html, pageUrl);

    expect(body).toContain('href="https://focustaiwan.tw/politics/topic"');
    expect(body).toContain("(By Reporter One and Reporter Two)");
    expect(body).not.toContain("Enditem");
    expect(body).not.toContain("Advertisement");
    expect(images).toMatchObject([
      { role: "lead", caption: "Lead caption", width: 1200, height: 800 },
      { role: "content", afterBlock: 2, caption: "Inline caption", width: 1000, height: 700 },
    ]);
  });

  it("places a Focus Taiwan image after sanitized blocks, ignoring short and duplicate paragraphs", () => {
    const repeated = "The first substantive paragraph contains enough publisher reporting to remain in the archived body.";
    const html = `<div class="PrimarySide"><div class="paragraph">
      <p>${repeated}</p>
      <p>Too short.</p>
      <p>${repeated}</p>
      <p>The second substantive paragraph appears immediately before the publisher photograph.</p>
      <div class="media"><figure><picture><img src="/sanitized-position.jpg"></picture><figcaption>Sanitized-position caption</figcaption></figure></div>
      <p>The final substantive paragraph follows the photograph in the original source order.</p>
    </div></div>`;
    const pageUrl = "https://focustaiwan.tw/politics/202608300099";

    const body = extractFocusTaiwanBody(html, quality, pageUrl);
    const image = extractFocusTaiwanImages(html, pageUrl)[0];

    expect(body).toBeDefined();
    expect(body?.match(/<p>/gu)).toHaveLength(3);
    expect(image).toMatchObject({ afterBlock: 2, caption: "Sanitized-position caption" });
    const archived = attachAssetsToBody(body!, [capturedAsset("sanitized-position", image!)]);
    expect(archived.indexOf("The second substantive paragraph")).toBeLessThan(archived.indexOf('data-asset-id="sanitized-position"'));
    expect(archived.indexOf('data-asset-id="sanitized-position"')).toBeLessThan(archived.indexOf("The final substantive paragraph"));
  });

  it("confirms CNA's existing semantic selector and image adapter exclude recommendation modules", () => {
    const pageUrl = "https://www.channelnewsasia.com/asia/example-123";
    const html = `<article class="node node--article-content"><div class="content">
      <figure class="detail-hero-media"><img src="/hero.jpg" alt="Hero"><figcaption>Hero caption</figcaption></figure>
      <section class="block-field-blocknodearticlefield-content"><div class="text-long">
        <p>First CNA paragraph has a <a href="/asia/topic">publisher link</a> and enough reported detail.</p>
        <h2>SECTION HEADING</h2>
        <p>Second CNA paragraph completes the report with enough supporting context.</p>
      </div><figure><img src="/inline.jpg"><figcaption>Inline caption</figcaption></figure></section>
      <section class="also-worth-reading"><h2>Also worth reading</h2><figure><img src="/recommendation.jpg"></figure></section>
    </div></article>`;

    const body = extractArticleBody(html, cnaFetch, quality, extractCnaBody, pageUrl);
    const images = discoverArticleImages(html, pageUrl, cnaFetch, extractCnaImages);

    expect(body).toContain('href="https://www.channelnewsasia.com/asia/topic"');
    expect(body).not.toContain("Also worth reading");
    expect(images.map((image) => image.sourceUrl)).toEqual([
      "https://www.channelnewsasia.com/hero.jpg",
      "https://www.channelnewsasia.com/inline.jpg",
    ]);
  });
});
