import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverArticleImages } from "../src/capture/page-images.js";
import { extractNytImages } from "../src/sources/nyt/images.js";
import {
  captureNytGraphqlPage,
  nytGraphqlArticleHtml,
  parseNytGraphqlConfig,
  resetNytGraphqlConfigCacheForTests,
} from "../src/sources/nyt/graphql.js";
import { extractNytBody } from "../src/sources/nyt/process.js";
import { sourcePageCapture } from "../src/sources/registry.js";
import fixtures from "./nyt-graphql.fixtures.json";

const PAGE_URL = "https://www.nytimes.com/2026/08/30/world/canada/lake-ontario-america-google-maps.html";
const ENDPOINT = "https://samizdat-graphql.nytimes.com/graphql/v2";

function configHtml(): string {
  return `<script>window.__preloadedData = {"initialData":undefined,"config":{"gqlUrlClient":"${ENDPOINT.replaceAll("/", "\\u002F")}","gqlRequestHeaders":{"nyt-app-type":"project-vi","nyt-app-version":"0.0.5","nyt-token":"public-page-token"}},"ssrQuery":{}};</script>`;
}

function text(value: string, formats: unknown[] = []): object {
  return { __typename: "TextInline", text: value, formats };
}

function paragraph(index: number, content?: object[]): object {
  return {
    __typename: "ParagraphBlock",
    content: content ?? [text(`Paragraph ${index} contains enough original reporting text to remain a semantic body block.`)],
  };
}

function image(id: string, caption: string): object {
  return {
    __typename: "ImageBlock",
    media: {
      __typename: "Image",
      altText: `${id} alternative text`,
      caption: { text: caption },
      credit: `${id} Photographer for The New York Times`,
      crops: [{ name: "superJumbo", renditions: [{
        name: "superJumbo",
        url: `https://static01.nyt.com/images/2026/08/30/${id}.jpg`,
        width: 2048,
        height: 1365,
      }] }],
    },
  };
}

function graphqlPayload(): object {
  const content: object[] = [{
    __typename: "HeaderBasicBlock",
    ledeMedia: image("map", "Google Maps map of Lake America."),
  }];
  for (let index = 1; index <= 14; index += 1) {
    content.push(index === 3
      ? paragraph(index, [
        text("Canadians "),
        text("have rallied behind Mr. Carney", [{
          __typename: "LinkFormat",
          url: "/2026/08/29/world/canada/carney.html",
          title: "Canada reacts",
        }, { __typename: "BoldFormat", type: "bold" }]),
        text(", but the dispute continues."),
      ])
      : index === 14
        ? paragraph(index, [text("Matina Stevis-Gridneff is the Canada bureau chief for The Times, leading coverage of the country.")])
        : paragraph(index));
    if (index === 5) content.push(image("toronto", "Lake Ontario in Toronto. Ontario is a historical Indigenous name for the lake."));
    if (index === 8) content.push({ __typename: "VideoBlock" }, image("road-sign", "A road sign beside Lake Ontario."));
  }
  return {
    data: {
      article: {
        __typename: "Article",
        headline: { default: "Google Maps Changes Lake Ontario to Lake America" },
        summary: "Users in the United States will see the new label, following President Trump’s executive order last week.",
        bylines: [{ creators: [{
          __typename: "Person",
          displayName: "Matina Stevis-Gridneff",
          url: "https://www.nytimes.com/by/matina-stevis-gridneff",
        }] }],
        body: { content },
      },
    },
  };
}

function imageMedia(id: string, caption: string): Record<string, unknown> {
  return (image(id, caption) as { media: Record<string, unknown> }).media;
}

function documentPromoWithFullImage(fullImgUrl: string): object {
  return {
    __typename: "UnstructuredBlock",
    dataType: "ExperimentalBlock_DocPromo",
    data: {
      type: "ExperimentalBlock_DocPromo",
      title: "Read the complete court decision",
      summary: "The official filing is available as a primary document.",
      content: [],
      formats: [],
      displayStyle: "Single Page",
      imageSelection: "1",
      documentData: {
        publishPath: "/interactive/2026/08/28/nyregion/fixture-decision.html",
        fullImgUrl,
        pages: 35,
      },
      isUnstructured: true,
    },
    unstructuredMedia: [],
  };
}

function auditedBlocksPayload(): object {
  return {
    data: {
      article: {
        __typename: "Article",
        headline: { default: "Audited New York Times GraphQL Blocks" },
        summary: "The official standfirst must precede every publisher-authored media group in this fixture.",
        bylines: [],
        body: {
          content: [
            { __typename: "HeaderBasicBlock", ledeMedia: image("audited-lead", "The audited lead image.") },
            paragraph(1),
            { __typename: "Heading1Block", content: [text("A publisher heading rendered below the article title")] },
            { __typename: "LabelBlock", labelContent: [text("Quote of the day")] },
            {
              __typename: "BylineBlock",
              role: [],
              bylines: [{
                prefix: "By",
                renderedRepresentation: "By Aruni Soni",
                creators: [{
                  __typename: "Person",
                  displayName: "Aruni Soni",
                  url: "https://www.nytimes.com/by/aruni-soni",
                }],
              }],
            },
            {
              __typename: "GridBlock",
              caption: "Two publisher photographs form the first audited grid.",
              credit: "Grid Photographer/The New York Times",
              gridMedia: [imageMedia("grid-one", ""), imageMedia("grid-two", "Second grid caption.")],
            },
            {
              __typename: "SlideshowBlock",
              slideshowMedia: {
                __typename: "Slideshow",
                slides: [
                  { __typename: "SlideshowSlide", legacyHtmlCaption: "First slideshow caption.", image: imageMedia("slide-one", "") },
                  // The official query exposes only slide.image. A video slide
                  // therefore arrives as an audited slide with no image.
                  { __typename: "SlideshowSlide", image: null },
                  { __typename: "SlideshowSlide", legacyHtmlCaption: "Second slideshow caption.", image: imageMedia("slide-two", "") },
                ],
              },
            },
            {
              __typename: "SlideshowBlock",
              slideshowMedia: {
                __typename: "Slideshow",
                slides: [
                  { __typename: "SlideshowSlide", image: imageMedia("slide-three", "Third slideshow caption.") },
                  { __typename: "SlideshowSlide", image: imageMedia("slide-four", "Fourth slideshow caption.") },
                ],
              },
            },
            {
              __typename: "CapsuleBlock",
              capsuleContent: {
                __typename: "Capsule",
                body: { content: [{ __typename: "HeaderBasicBlock", capsuleLedeMedia: null }, paragraph(2)] },
              },
            },
            {
              __typename: "CapsuleBlock",
              capsuleContent: {
                __typename: "Capsule",
                body: {
                  content: [
                    { __typename: "HeaderBasicBlock", capsuleLedeMedia: null },
                    { __typename: "ParagraphBlock", content: [] },
                    {
                      __typename: "VisualStackBlock",
                      label: { __typename: "ParagraphBlock", content: [text("")] },
                      heading: { __typename: "Heading2Block", content: [text("")] },
                      visualContent: [
                        { __typename: "ParagraphBlock", content: [text("DO NOT DELETE THIS CAPSULE. It will display a module with links to today’s games.")] },
                        { __typename: "ParagraphBlock", content: [text("Insert a horizontal rule below this capsule.")] },
                      ],
                      visualMedia: null,
                    },
                  ],
                },
              },
            },
            {
              __typename: "GroupBlock",
              groupContent: [
                paragraph(3),
                image("group-one", "The group image remains between its surrounding paragraphs."),
                paragraph(4),
              ],
            },
            {
              __typename: "UnstructuredBlock",
              dataType: "ExperimentalBlock_AdHint",
              data: JSON.stringify({ type: "ExperimentalBlock_AdHint", content: [], formats: [], isUnstructured: true }),
              unstructuredMedia: [],
            },
            {
              __typename: "UnstructuredBlock",
              dataType: "ExperimentalBlock_BulletBriefing",
              data: {
                type: "ExperimentalBlock_BulletBriefing",
                ledeText: "In today's newsletter:",
                content: [],
                formats: [],
                isUnstructured: true,
              },
              unstructuredMedia: [],
            },
            {
              __typename: "UnstructuredBlock",
              dataType: "ExperimentalBlock_DocPromo",
              data: {
                type: "ExperimentalBlock_DocPromo",
                title: "Read the complete court decision",
                summary: "The official filing is available as a primary document.",
                content: [],
                formats: [],
                displayStyle: "Single Page",
                imageSelection: "1",
                documentData: {
                  publishPath: "/interactive/2026/08/28/nyregion/fixture-decision.html",
                  assetsHost: "static01.nyt.com",
                  assetsFolder: "newsgraphics/documenttools/fixture123/",
                  pages: 35,
                },
                isUnstructured: true,
              },
              unstructuredMedia: [],
            },
            {
              __typename: "VisualStackBlock",
              label: { __typename: "ParagraphBlock", content: [text("Scenes from the flood")] },
              heading: { __typename: "Heading2Block", content: [text("A visual account")] },
              visualContent: [{ __typename: "ParagraphBlock", content: [text("People's belongings remained in the debris after the water receded.")] }],
              visualMedia: image("visual-stack", ""),
            },
            {
              __typename: "DocumentTearBlock",
              tearTitle: { __typename: "Heading3Block", content: [text("An email sent before the meeting")] },
              tearContent: [{
                __typename: "ParagraphBlock",
                content: [text("Dear colleague,"), { __typename: "LineBreakInline" }, text("This complete message remains in the official article body and preserves its line break.")],
              }],
              tearCaption: { __typename: "DetailBlock", content: [text("The message was supplied by its recipient.")] },
              tearSource: { __typename: "DetailBlock", content: [] },
              tearMedia: null,
            },
            {
              __typename: "InteractiveBlock",
              media: {
                __typename: "EmbeddedInteractive",
                html: '<script src="https://datawrapper.dwcdn.net/FnZXU/embed.js"></script><iframe title="A Datawrapper chart of the audited totals" src="https://datawrapper.dwcdn.net/FnZXU/21/?plain=1"></iframe>',
              },
            },
            {
              __typename: "InteractiveBlock",
              media: {
                __typename: "EmbeddedInteractive",
                appName: "Attribute",
                slug: "how-did-this-happen",
                compatibility: "INLINE",
                html: '<script>window.attribute = true;</script><div id="formpreview" data-formdata="{&quot;slug&quot;:&quot;fixture&quot;}"></div><link rel="stylesheet" href="https://int.nyt.com/apps/attribute-newsapp/style.css"><script src="https://int.nyt.com/apps/attribute-newsapp/client.js"></script>',
              },
            },
            {
              __typename: "InteractiveBlock",
              media: {
                __typename: "EmbeddedInteractive",
                appName: "",
                slug: "metropolitandiary-imagesalignment",
                compatibility: "INLINE",
                html: "<!--FOR POSITIONING METRO DIARY ILLOS--><style>.StoryBodyCompanionColumn figure { margin: 0; }</style>",
              },
            },
            paragraph(5),
          ],
        },
      },
    },
  };
}

afterEach(() => {
  resetNytGraphqlConfigCacheForTests();
  vi.restoreAllMocks();
});

describe("NYT official GraphQL page capture", () => {
  it("parses the public GraphQL endpoint and headers from NYT preloaded config", () => {
    expect(parseNytGraphqlConfig(configHtml())).toEqual({
      endpoint: ENDPOINT,
      headers: {
        "nyt-app-type": "project-vi",
        "nyt-app-version": "0.0.5",
        "nyt-token": "public-page-token",
      },
    });
    expect(parseNytGraphqlConfig('<script>window.__preloadedData={"config":{"gqlUrlClient":"https://evil.example/graphql","gqlRequestHeaders":{"nyt-app-type":"x","nyt-app-version":"1","nyt-token":"x"}}}</script>')).toBeUndefined();
  });

  it("builds complete semantic HTML with links and images in publisher order", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === "https://www.nytimes.com/manifest.json") {
        return new Response(configHtml(), { status: 404, headers: { "content-type": "text/html" } });
      }
      expect(String(input)).toBe(ENDPOINT);
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("nyt-token")).toBe("public-page-token");
      const body = JSON.parse(String(init?.body)) as { operationName: string; variables: { id: string }; query: string };
      expect(body.operationName).toBe("ArticleQuery");
      expect(body.variables.id).toBe("/2026/08/30/world/canada/lake-ontario-america-google-maps.html");
      expect(body.query).toContain("query ArticleQuery");
      expect(body.query).toContain("... on DetailBlock");
      expect(body.query).toContain("... on HeaderFullBleedVerticalBlock");
      expect(body.query).toContain("... on DiptychBlock");
      expect(body.query).toContain("... on InteractiveBlock");
      expect(body.query).toContain("... on GridBlock");
      expect(body.query).toContain("... on SlideshowBlock");
      expect(body.query).toContain("... on GroupBlock");
      expect(body.query).toContain("... on VisualStackBlock");
      expect(body.query).toContain("... on DocumentTearBlock");
      expect(body.query).toContain("... on HeaderMultimediaBlock");
      return new Response(JSON.stringify(graphqlPayload()), { status: 200, headers: { "content-type": "application/json" } });
    });

    const page = await captureNytGraphqlPage(PAGE_URL, 10, fetchMock as unknown as typeof fetch);

    expect(page).toEqual(expect.objectContaining({ method: "direct", status: 200, finalUrl: PAGE_URL }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const html = page?.renderedHtml ?? "";
    const body = extractNytBody(html, { minimumCharacters: 100, minimumParagraphs: 3 }, PAGE_URL) ?? "";
    expect(body).toContain("Users in the United States will see the new label");
    expect(body).toContain('<a href="https://www.nytimes.com/2026/08/29/world/canada/carney.html"');
    expect(body).toContain('<a href="https://www.nytimes.com/by/matina-stevis-gridneff"');
    expect(body.match(/Canada bureau chief for The Times/gu)).toHaveLength(1);
    expect(body).not.toContain("Related Content");

    const images = extractNytImages(html, PAGE_URL);
    expect(images).toHaveLength(3);
    expect(images.map((value) => ({ role: value.role, afterBlock: value.afterBlock, caption: value.caption, credit: value.credit }))).toEqual([
      expect.objectContaining({ role: "content", afterBlock: 1, caption: expect.stringContaining("Google Maps map"), credit: expect.stringContaining("map Photographer") }),
      expect.objectContaining({ role: "content", afterBlock: 6, caption: expect.stringContaining("Lake Ontario in Toronto"), credit: expect.stringContaining("toronto Photographer") }),
      expect.objectContaining({ role: "content", afterBlock: 9, caption: expect.stringContaining("road sign"), credit: expect.stringContaining("road-sign Photographer") }),
    ]);
  });

  it("caches config per process and returns undefined so generic capture can take over on failures", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => String(input) === "https://www.nytimes.com/manifest.json"
      ? new Response(configHtml(), { status: 404 })
      : new Response("blocked", { status: 403 }));

    await expect(captureNytGraphqlPage(PAGE_URL, 10, fetchMock as unknown as typeof fetch)).resolves.toBeUndefined();
    await expect(captureNytGraphqlPage(PAGE_URL, 10, fetchMock as unknown as typeof fetch)).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "https://www.nytimes.com/manifest.json")).toHaveLength(1);

    expect(sourcePageCapture("nyt")).toBeTypeOf("function");
    expect(sourcePageCapture("ap")).toBeUndefined();
  });

  it("fails closed on an unknown block so a future meaningful block cannot be silently omitted", async () => {
    const payload = graphqlPayload() as { data: { article: { body: { content: object[] } } } };
    payload.data.article.body.content.splice(2, 0, { __typename: "FutureMeaningfulBlock" });
    const fetchMock = vi.fn(async (input: string | URL | Request) => String(input) === "https://www.nytimes.com/manifest.json"
      ? new Response(configHtml(), { status: 404 })
      : new Response(JSON.stringify(payload), { status: 200 }));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const page = await captureNytGraphqlPage(PAGE_URL, 10, fetchMock as unknown as typeof fetch);

    expect(page).toBeUndefined();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("unsupported FutureMeaningfulBlock"));
  });

  it("renders every audited block shape, ignores recirculation, and preserves interactive media order", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const html = nytGraphqlArticleHtml(fixtures.observedBlocks, PAGE_URL) ?? "";
    const body = extractNytBody(html, { minimumCharacters: 100, minimumParagraphs: 3 }, PAGE_URL) ?? "";

    expect(body).toContain('<h2><a href="https://www.nytimes.com/interactive/fixture-heading.html"');
    expect(body).toContain("<h3>A smaller subsection heading</h3>");
    expect(body).toContain("<blockquote><p><em>This quoted passage remains part of the official article.</em></p></blockquote>");
    expect(body).toContain('href="https://www.nytimes.com/interactive/source.html"');
    expect(body).toContain('href="https://www.nytimes.com/interactive/complete-fixture.html"');
    expect(body).toContain("<ol><li>The first list item is retained.</li><li>The second list item follows it.</li></ol>");
    expect(body).toContain("The final reporting paragraph proves");
    expect(body).not.toContain("CommentsBlock");
    expect(body).not.toContain("RelatedLinksBlock");
    expect(body.indexOf("opening paragraph")).toBeLessThan(body.indexOf("linked section heading"));
    expect(body.indexOf("quoted passage")).toBeLessThan(body.indexOf("Interactive chart context"));
    expect(warning).not.toHaveBeenCalledWith(expect.stringContaining("unsupported"));

    expect(extractNytImages(html, PAGE_URL).map((image) => ({
      sourceUrl: image.sourceUrl,
      role: image.role,
      afterBlock: image.afterBlock,
    }))).toEqual([
      { sourceUrl: "https://static01.nyt.com/images/fixture/vertical-lead.jpg", role: "content", afterBlock: 1 },
      { sourceUrl: "https://static01.nyt.com/images/fixture/diptych-one.jpg", role: "content", afterBlock: 7 },
      { sourceUrl: "https://static01.nyt.com/images/fixture/diptych-two.jpg", role: "content", afterBlock: 7 },
      { sourceUrl: "https://static01.nyt.com/images/fixture/interactive-chart.png", role: "content", afterBlock: 8 },
    ]);
  });

  it("renders audited containers, embedded bylines, image grids, slideshows, visual stacks, document tears, and Datawrapper previews", () => {
    const html = nytGraphqlArticleHtml(auditedBlocksPayload(), PAGE_URL) ?? "";
    const body = extractNytBody(html, { minimumCharacters: 100, minimumParagraphs: 3 }, PAGE_URL) ?? "";

    expect(body).toContain("<h2>A publisher heading rendered below the article title</h2>");
    expect(body).toContain('<h3>Quote of the day</h3>');
    expect(body).toContain('<h4>By <a href="https://www.nytimes.com/by/aruni-soni"');
    expect(body).toContain("Paragraph 2 contains enough original reporting text");
    expect(body).toContain("Paragraph 3 contains enough original reporting text");
    expect(body).toContain("Paragraph 4 contains enough original reporting text");
    expect(body).toContain("In today's newsletter:");
    expect(body).toContain('href="https://www.nytimes.com/interactive/2026/08/28/nyregion/fixture-decision.html"');
    expect(body).toContain("An email sent before the meeting");
    expect(body).toContain("Dear colleague,<br>This complete message remains");
    expect(body).toContain("The message was supplied by its recipient.");
    expect(body).not.toContain("DO NOT DELETE THIS CAPSULE");
    expect(body).not.toContain("Insert a horizontal rule below this capsule");
    expect(html).not.toContain("formpreview");
    expect(html).not.toContain("FOR POSITIONING METRO DIARY ILLOS");

    const images = extractNytImages(html, PAGE_URL);
    const urls = images.map((value) => value.sourceUrl);
    expect(urls).toEqual([
      "https://static01.nyt.com/images/2026/08/30/audited-lead.jpg",
      "https://static01.nyt.com/images/2026/08/30/grid-one.jpg",
      "https://static01.nyt.com/images/2026/08/30/grid-two.jpg",
      "https://static01.nyt.com/images/2026/08/30/slide-one.jpg",
      "https://static01.nyt.com/images/2026/08/30/slide-two.jpg",
      "https://static01.nyt.com/images/2026/08/30/slide-three.jpg",
      "https://static01.nyt.com/images/2026/08/30/slide-four.jpg",
      "https://static01.nyt.com/images/2026/08/30/group-one.jpg",
      "https://static01.nyt.com/newsgraphics/documenttools/fixture123/1/output-1.png",
      "https://static01.nyt.com/images/2026/08/30/visual-stack.jpg",
      "https://datawrapper.dwcdn.net/FnZXU/plain-s.png?v=21",
    ]);
    expect(images.find((value) => value.sourceUrl.endsWith("visual-stack.jpg"))?.caption).toContain("belongings remained in the debris");
    expect(images.filter((value) => value.presentation?.id === "nyt-slideshow-1").map((value) => value.presentation)).toEqual([
      { type: "carousel", id: "nyt-slideshow-1", order: 0, total: 2 },
      { type: "carousel", id: "nyt-slideshow-1", order: 1, total: 2 },
    ]);
    expect(images.filter((value) => value.presentation?.id === "nyt-slideshow-2").map((value) => value.presentation)).toEqual([
      { type: "carousel", id: "nyt-slideshow-2", order: 0, total: 2 },
      { type: "carousel", id: "nyt-slideshow-2", order: 1, total: 2 },
    ]);
  });

  it("keeps HeaderMultimedia audio artwork and HeaderBasic slideshow/CardDeck media in source-specific lead order", () => {
    const multimedia = graphqlPayload() as { data: { article: { body: { content: object[] } } } };
    multimedia.data.article.body.content[0] = {
      __typename: "HeaderMultimediaBlock",
      headerMedia: {
        __typename: "AudioBlock",
        media: { __typename: "Audio", promotionalMedia: imageMedia("audio-promo", "Podcast artwork.") },
      },
    };
    const multimediaImages = extractNytImages(nytGraphqlArticleHtml(multimedia, PAGE_URL) ?? "", PAGE_URL);
    expect(multimediaImages[0]).toMatchObject({
      sourceUrl: "https://static01.nyt.com/images/2026/08/30/audio-promo.jpg",
      role: "content",
      afterBlock: 1,
    });

    const slideshow = graphqlPayload() as { data: { article: { body: { content: object[] } } } };
    slideshow.data.article.body.content[0] = {
      __typename: "HeaderBasicBlock",
      ledeMedia: {
        __typename: "SlideshowBlock",
        slideshowMedia: {
          __typename: "Slideshow",
          slides: [
            { __typename: "SlideshowSlide", image: imageMedia("header-slide-one", "Header slide one.") },
            { __typename: "SlideshowSlide", image: imageMedia("header-slide-two", "Header slide two.") },
          ],
        },
      },
    };
    const slideshowImages = extractNytImages(nytGraphqlArticleHtml(slideshow, PAGE_URL) ?? "", PAGE_URL);
    expect(slideshowImages.slice(0, 2).map((value) => ({ role: value.role, afterBlock: value.afterBlock, presentation: value.presentation }))).toEqual([
      { role: "content", afterBlock: 1, presentation: { type: "carousel", id: "nyt-slideshow-1", order: 0, total: 2 } },
      { role: "content", afterBlock: 1, presentation: { type: "carousel", id: "nyt-slideshow-1", order: 1, total: 2 } },
    ]);
    const slideshowArticle = slideshow.data.article as { summary?: string; body: { content: object[] } };
    delete slideshowArticle.summary;
    slideshowArticle.body.content.splice(1, 0, image("prebody-after-slideshow", "A later pre-paragraph image."));
    const withoutSummaryImages = extractNytImages(nytGraphqlArticleHtml(slideshow, PAGE_URL) ?? "", PAGE_URL);
    expect(withoutSummaryImages.slice(0, 3).map((value) => ({ sourceUrl: value.sourceUrl, role: value.role, afterBlock: value.afterBlock }))).toEqual([
      { sourceUrl: "https://static01.nyt.com/images/2026/08/30/header-slide-one.jpg", role: "content", afterBlock: 0 },
      { sourceUrl: "https://static01.nyt.com/images/2026/08/30/header-slide-two.jpg", role: "content", afterBlock: 0 },
      { sourceUrl: "https://static01.nyt.com/images/2026/08/30/prebody-after-slideshow.jpg", role: "content", afterBlock: 0 },
    ]);

    const cardDeck = graphqlPayload() as { data: { article: { summary?: string; body: { content: object[] } } } };
    delete cardDeck.data.article.summary;
    cardDeck.data.article.body.content[0] = {
      __typename: "HeaderBasicBlock",
      ledeMedia: {
        __typename: "CardDeckBlock",
        media: { __typename: "CardDeck", promotionalMedia: imageMedia("card-deck", "Candidate mosaic.") },
      },
    };
    expect(extractNytImages(nytGraphqlArticleHtml(cardDeck, PAGE_URL) ?? "", PAGE_URL)[0]).toMatchObject({
      sourceUrl: "https://static01.nyt.com/images/2026/08/30/card-deck.jpg",
      role: "lead",
    });
  });

  it("selects one audited Runway breakpoint, preserves accessible text, and skips only exact paid-video chrome", () => {
    const payload = graphqlPayload() as { data: { article: { body: { content: Array<Record<string, unknown>> } } } };
    payload.data.article.body.content.splice(2, 0,
      {
        __typename: "InteractiveBlock",
        media: {
          __typename: "EmbeddedInteractive",
          appName: "Runway",
          compatibility: "INLINE",
          slug: "tennis-attendance-tennis-attendance",
          html: '<div class="figma2html"><figure><img src="https://static01.nyt.com/images/fixture/chart-mobile.jpg" alt="" width="335" height="435"><p>One million attendees</p></figure><figure><img src="https://static01.nyt.com/images/fixture/chart-desktop.jpg" alt="Attendance rose to one million" width="600" height="435"><p>One million attendees</p></figure></div>',
        },
      },
      {
        __typename: "InteractiveBlock",
        media: {
          __typename: "EmbeddedInteractive",
          appName: "Runway",
          compatibility: "INLINE",
          slug: "2026-08-28-liberia-deportation-map-liberia-deportation-flight",
          html: '<div class="ai2html" role="img" aria-describedby="map-description"><div class="g-aiAltText" id="map-description">Map locates Monrovia and Marshall in Liberia.</div><div class="g-artboard" data-min-width="0"><img src="https://static01.nyt.com/images/fixture/liberia-map.png" alt=""><p>Monrovia</p><p>Marshall</p></div></div>',
        },
      },
      {
        __typename: "InteractiveBlock",
        media: {
          __typename: "EmbeddedInteractive",
          appName: "Runway",
          compatibility: "INLINE",
          slug: "paid-influence-dash",
          html: '<div class="row-caption">In <strong>May</strong>, the creator endorsed a candidate.<p>He was paid by the campaign.</p></div><div class="phone-screen" role="presentation"><video src="https://static01.nyt.com/video/waived.mp4"></video><button type="button" class="mute-button" aria-label="Unmute video"><svg><path></path></svg></button><img class="phone-frame" src="https://static01.nyt.com/images/fixture/iphone.png" alt=""></div>',
        },
      },
      {
        __typename: "InteractiveBlock",
        media: {
          __typename: "EmbeddedInteractive",
          appName: "Runway",
          compatibility: "INLINE",
          slug: "dahlias-1",
          html: '<script data-attr="nyt-asset-manifest">{"images":[]}</script><script></script><style></style><img src="https://static01.nyt.com/images/fixture/dahlia-1.jpg" alt="" width="600" height="800"><img src="https://static01.nyt.com/images/fixture/dahlia-2.jpg" alt="" width="600" height="800"><img src="https://static01.nyt.com/images/fixture/dahlia-3.jpg" alt="" width="600" height="800"><img src="https://static01.nyt.com/images/fixture/dahlia-4.jpg" alt="" width="600" height="800"><img src="https://static01.nyt.com/images/fixture/dahlia-5.jpg" alt="" width="600" height="800"><video class="g-videoplayer" muted loop playsinline preload="none"><source src="https://vp.nyt.com/video/fixture.mp4" type="video/mp4"></video>',
        },
      });

    const html = nytGraphqlArticleHtml(payload, PAGE_URL) ?? "";
    const body = extractNytBody(html, { minimumCharacters: 100, minimumParagraphs: 3 }, PAGE_URL) ?? "";
    const images = extractNytImages(html, PAGE_URL);

    expect(body).toContain("One million attendees");
    expect(body).toContain("In <strong>May</strong>, the creator endorsed a candidate.");
    expect(body).toContain("He was paid by the campaign.");
    expect(images.map((value) => value.sourceUrl)).toContain("https://static01.nyt.com/images/fixture/chart-desktop.jpg");
    expect(images.map((value) => value.sourceUrl)).not.toContain("https://static01.nyt.com/images/fixture/chart-mobile.jpg");
    expect(images).toContainEqual(expect.objectContaining({
      sourceUrl: "https://static01.nyt.com/images/fixture/liberia-map.png",
      alt: "Map locates Monrovia and Marshall in Liberia.",
    }));
    expect(html).not.toContain("iphone.png");
    expect(html).not.toContain("mute-button");
    expect(images.filter((value) => value.sourceUrl.includes("/dahlia-")).map((value) => value.sourceUrl)).toEqual([
      "https://static01.nyt.com/images/fixture/dahlia-1.jpg",
      "https://static01.nyt.com/images/fixture/dahlia-2.jpg",
      "https://static01.nyt.com/images/fixture/dahlia-3.jpg",
      "https://static01.nyt.com/images/fixture/dahlia-4.jpg",
      "https://static01.nyt.com/images/fixture/dahlia-5.jpg",
    ]);
  });

  it("fails closed on partial GraphQL data, unsupported inline data, and unqueried nested blocks", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(nytGraphqlArticleHtml({ ...graphqlPayload(), errors: [{ message: "resolver failed" }] }, PAGE_URL)).toBeUndefined();

    const inline = graphqlPayload() as { data: { article: { body: { content: Array<Record<string, unknown>> } } } };
    inline.data.article.body.content[1] = {
      __typename: "ParagraphBlock",
      content: [{ __typename: "FutureInline", text: "Text that the query cannot prove complete." }],
    };
    expect(nytGraphqlArticleHtml(inline, PAGE_URL)).toBeUndefined();

    const format = graphqlPayload() as { data: { article: { body: { content: Array<Record<string, unknown>> } } } };
    format.data.article.body.content[1] = paragraph(1, [text("Unknown formatting semantics", [{ __typename: "FutureFormat" }])]) as Record<string, unknown>;
    expect(nytGraphqlArticleHtml(format, PAGE_URL)).toBeUndefined();

    const nested = graphqlPayload() as { data: { article: { body: { content: Array<Record<string, unknown>> } } } };
    nested.data.article.body.content[1] = {
      __typename: "GroupBlock",
      groupContent: [{ __typename: "ListBlock" }],
    };
    expect(nytGraphqlArticleHtml(nested, PAGE_URL)).toBeUndefined();

    const interactive = graphqlPayload() as { data: { article: { body: { content: Array<Record<string, unknown>> } } } };
    interactive.data.article.body.content[1] = {
      __typename: "InteractiveBlock",
      media: { __typename: "FutureInteractiveMedia", html: "<p>Unqueried media text</p>" },
    };
    expect(nytGraphqlArticleHtml(interactive, PAGE_URL)).toBeUndefined();
    const unknownIframe = graphqlPayload() as { data: { article: { body: { content: Array<Record<string, unknown>> } } } };
    unknownIframe.data.article.body.content[1] = {
      __typename: "InteractiveBlock",
      media: {
        __typename: "EmbeddedInteractive",
        appName: "FutureProvider",
        slug: "future-visual",
        compatibility: "INLINE",
        html: '<iframe title="A meaningful future visualization" src="https://visual.example/embed/1"></iframe>',
      },
    };
    expect(nytGraphqlArticleHtml(unknownIframe, PAGE_URL)).toBeUndefined();
    const mixedIframes = graphqlPayload() as { data: { article: { body: { content: Array<Record<string, unknown>> } } } };
    mixedIframes.data.article.body.content[1] = {
      __typename: "InteractiveBlock",
      media: {
        __typename: "EmbeddedInteractive",
        appName: "FutureProvider",
        slug: "mixed-known-and-unknown-visuals",
        compatibility: "INLINE",
        html: '<iframe title="A supported chart" src="https://datawrapper.dwcdn.net/FnZXU/21/?plain=1"></iframe><iframe title="A second meaningful visualization" src="https://visual.example/embed/2"></iframe>',
      },
    };
    expect(nytGraphqlArticleHtml(mixedIframes, PAGE_URL)).toBeUndefined();

    const mixedControl = graphqlPayload() as { data: { article: { body: { content: Array<Record<string, unknown>> } } } };
    mixedControl.data.article.body.content[1] = {
      __typename: "InteractiveBlock",
      media: {
        __typename: "EmbeddedInteractive",
        appName: "FutureProvider",
        slug: "mixed-image-and-control",
        compatibility: "INLINE",
        html: '<img src="https://static01.nyt.com/images/fixture/known-preview.png" alt="A known preview"><button aria-label="Reveal the rest of the visual"></button><input aria-label="Change the visualized year">',
      },
    };
    expect(nytGraphqlArticleHtml(mixedControl, PAGE_URL)).toBeUndefined();

    const metadataOnlyInteractive = graphqlPayload() as { data: { article: { body: { content: Array<Record<string, unknown>> } } } };
    metadataOnlyInteractive.data.article.body.content[1] = {
      __typename: "InteractiveBlock",
      media: {
        __typename: "Interactive",
        id: "future-interactive-id",
        sourceApplication: "future-publisher-visual",
        firstPublished: "2026-08-30T00:00:00Z",
      },
    };
    expect(nytGraphqlArticleHtml(metadataOnlyInteractive, PAGE_URL)).toBeUndefined();

    const metadataOnlyEmbedded = graphqlPayload() as { data: { article: { body: { content: Array<Record<string, unknown>> } } } };
    metadataOnlyEmbedded.data.article.body.content[1] = {
      __typename: "InteractiveBlock",
      media: { __typename: "EmbeddedInteractive", id: "future-embed-id", appName: "FutureProvider", html: "" },
    };
    expect(nytGraphqlArticleHtml(metadataOnlyEmbedded, PAGE_URL)).toBeUndefined();
    const dynamicRunway = graphqlPayload() as { data: { article: { body: { content: Array<Record<string, unknown>> } } } };
    dynamicRunway.data.article.body.content[1] = {
      __typename: "InteractiveBlock",
      media: {
        __typename: "EmbeddedInteractive",
        appName: "Runway",
        compatibility: "INLINE",
        slug: "cushing-oil-charts",
        html: '<script data-attr="nyt-asset-manifest">{"images":[]}</script><h3>Cushing, Okla.</h3><h3>Strategic Petroleum Reserve</h3>',
      },
    };
    expect(nytGraphqlArticleHtml(dynamicRunway, PAGE_URL)).toBeUndefined();

    const futureRunway = graphqlPayload() as { data: { article: { body: { content: Array<Record<string, unknown>> } } } };
    futureRunway.data.article.body.content[1] = {
      __typename: "InteractiveBlock",
      media: {
        __typename: "EmbeddedInteractive",
        appName: "Runway",
        compatibility: "INLINE",
        slug: "future-client-chart",
        html: '<script data-attr="nyt-asset-manifest">{"images":[]}</script><h3>A future chart title</h3><h3>A future chart subtitle</h3>',
      },
    };
    expect(nytGraphqlArticleHtml(futureRunway, PAGE_URL)).toBeUndefined();

    const textOnlyHeaderInteractive = graphqlPayload() as { data: { article: { body: { content: Array<Record<string, unknown>> } } } };
    textOnlyHeaderInteractive.data.article.body.content[0] = {
      __typename: "HeaderBasicBlock",
      ledeMedia: {
        __typename: "InteractiveBlock",
        media: {
          __typename: "EmbeddedInteractive",
          appName: "AuditedTextProvider",
          slug: "text-only-header",
          compatibility: "INLINE",
          html: "<p>This visible header text must not be stranded outside articleBody.</p>",
        },
      },
    };
    expect(nytGraphqlArticleHtml(textOnlyHeaderInteractive, PAGE_URL)).toBeUndefined();
    const headerInteractive = graphqlPayload() as { data: { article: { body: { content: Array<Record<string, unknown>> } } } };
    headerInteractive.data.article.body.content[0] = {
      __typename: "HeaderBasicBlock",
      ledeMedia: { __typename: "InteractiveBlock", media: { __typename: "FutureInteractiveMedia" } },
    };
    expect(nytGraphqlArticleHtml(headerInteractive, PAGE_URL)).toBeUndefined();

    const diptych = graphqlPayload() as { data: { article: { body: { content: Array<Record<string, unknown>> } } } };
    diptych.data.article.body.content[1] = {
      __typename: "DiptychBlock",
      imageOne: imageMedia("partial-diptych", "Only one side was returned."),
    };
    expect(nytGraphqlArticleHtml(diptych, PAGE_URL)).toBeUndefined();

    const emptyGrid = graphqlPayload() as { data: { article: { body: { content: Array<Record<string, unknown>> } } } };
    emptyGrid.data.article.body.content[1] = { __typename: "GridBlock", gridMedia: [] };
    expect(nytGraphqlArticleHtml(emptyGrid, PAGE_URL)).toBeUndefined();

    const nonEmptyAdHint = graphqlPayload() as { data: { article: { body: { content: Array<Record<string, unknown>> } } } };
    nonEmptyAdHint.data.article.body.content[1] = {
      __typename: "UnstructuredBlock",
      dataType: "ExperimentalBlock_AdHint",
      data: { type: "ExperimentalBlock_AdHint", content: ["future content"], formats: [], isUnstructured: true },
      unstructuredMedia: [],
    };
    expect(nytGraphqlArticleHtml(nonEmptyAdHint, PAGE_URL)).toBeUndefined();

    const maliciousFullPreview = graphqlPayload() as { data: { article: { body: { content: Array<Record<string, unknown>> } } } };
    maliciousFullPreview.data.article.body.content[1] = documentPromoWithFullImage("https://static01.nyt.com.evil.example/images/document-preview.png") as Record<string, unknown>;
    expect(nytGraphqlArticleHtml(maliciousFullPreview, PAGE_URL)).toBeUndefined();

    const unsafeFullPreviewPath = graphqlPayload() as { data: { article: { body: { content: Array<Record<string, unknown>> } } } };
    unsafeFullPreviewPath.data.article.body.content[1] = documentPromoWithFullImage("https://static01.nyt.com/images/document-preview.svg?download=1") as Record<string, unknown>;
    expect(nytGraphqlArticleHtml(unsafeFullPreviewPath, PAGE_URL)).toBeUndefined();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("falling back to generic capture"));
  });

  it("renders and verifies an official DocPromo fullImgUrl without constructed asset metadata", async () => {
    const previewUrl = "https://static01.nyt.com/images/2026/08/30/document-promo.jpg";
    const payload = graphqlPayload() as { data: { article: { body: { content: Array<Record<string, unknown>> } } } };
    payload.data.article.body.content[1] = documentPromoWithFullImage(previewUrl) as Record<string, unknown>;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === "https://www.nytimes.com/manifest.json") return new Response(configHtml(), { status: 404 });
      if (init?.method === "HEAD") {
        expect(String(input)).toBe(previewUrl);
        return new Response(null, { status: 200, headers: { "content-type": "image/jpeg" } });
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    });

    const page = await captureNytGraphqlPage(PAGE_URL, 10, fetchMock as unknown as typeof fetch);

    expect(page).toMatchObject({ method: "direct", status: 200 });
    expect(page?.renderedHtml).toContain('data-nyt-document-promo-full="true"');
    expect(discoverArticleImages(page?.renderedHtml ?? "", PAGE_URL, undefined, extractNytImages)).toContainEqual(expect.objectContaining({
      sourceUrl: previewUrl,
      publisherEditorial: true,
    }));
    expect(fetchMock).toHaveBeenCalledWith(previewUrl, expect.objectContaining({ method: "HEAD" }));
  });

  it("fails closed when a derived Datawrapper preview cannot be verified", async () => {
    let previewAvailable = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === "https://www.nytimes.com/manifest.json") return new Response(configHtml(), { status: 404 });
      if (init?.method === "HEAD") {
        if (String(input) === "https://static01.nyt.com/newsgraphics/documenttools/fixture123/1/output-1.png") {
          return new Response(null, { status: 200, headers: { "content-type": "image/png" } });
        }
        expect(String(input)).toBe("https://datawrapper.dwcdn.net/FnZXU/plain-s.png?v=21");
        return previewAvailable
          ? new Response(null, { status: 200, headers: { "content-type": "image/png" } })
          : new Response(null, { status: 503 });
      }
      return new Response(JSON.stringify(auditedBlocksPayload()), { status: 200, headers: { "content-type": "application/json" } });
    });

    await expect(captureNytGraphqlPage(PAGE_URL, 10, fetchMock as unknown as typeof fetch)).resolves.toBeUndefined();
    previewAvailable = true;
    await expect(captureNytGraphqlPage(PAGE_URL, 10, fetchMock as unknown as typeof fetch)).resolves.toMatchObject({
      method: "direct",
      status: 200,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://static01.nyt.com/newsgraphics/documenttools/fixture123/1/output-1.png",
      expect.objectContaining({ method: "HEAD" }),
    );
  });

  it("uses the same publisher lead semantics for a horizontal full-bleed header", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const payload = structuredClone(fixtures.observedBlocks) as {
      data: { article: { body: { content: Array<{ __typename?: string }> } } };
    };
    payload.data.article.body.content[0]!.__typename = "HeaderFullBleedHorizontalBlock";

    const html = nytGraphqlArticleHtml(payload, PAGE_URL) ?? "";

    expect(extractNytImages(html, PAGE_URL)[0]).toMatchObject({
      sourceUrl: "https://static01.nyt.com/images/fixture/vertical-lead.jpg",
      role: "content",
      afterBlock: 1,
    });
  });

  it("keeps the bc4826 empty media placeholder from forcing browser fallback", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => String(input) === "https://www.nytimes.com/manifest.json"
      ? new Response(configHtml(), { status: 404 })
      : new Response(JSON.stringify(fixtures.emptyParagraphBeforeImage), { status: 200 }));

    const page = await captureNytGraphqlPage(PAGE_URL, 10, fetchMock as unknown as typeof fetch);
    const html = page?.renderedHtml ?? "";
    const body = extractNytBody(html, { minimumCharacters: 100, minimumParagraphs: 3 }, PAGE_URL) ?? "";

    expect(page).toMatchObject({ method: "direct", status: 200 });
    expect(body).toContain("first substantial paragraph");
    expect(body).toContain("second substantial paragraph");
    expect(body).toContain("final substantial paragraph");
    expect(extractNytImages(html, PAGE_URL).map((image) => ({ sourceUrl: image.sourceUrl, afterBlock: image.afterBlock }))).toEqual([
      { sourceUrl: "https://static01.nyt.com/images/fixture/empty-case-lead.jpg", afterBlock: 1 },
      { sourceUrl: "https://static01.nyt.com/images/fixture/empty-case-inline.jpg", afterBlock: 2 },
    ]);
  });

  it("keeps a reliable creator link without importing a mutable profile biography", () => {
    const payload = graphqlPayload() as {
      data: { article: { bylines: Array<{ creators: Array<Record<string, unknown>> }>; body: { content: object[] } } };
    };
    payload.data.article.body.content = payload.data.article.body.content.slice(0, -1);
    payload.data.article.bylines[0]!.creators[0]!.description = "A mutable profile biography that is not part of this article.";

    const html = nytGraphqlArticleHtml(payload, PAGE_URL) ?? "";

    expect(html).toContain('data-testid="article-author"');
    expect(html).toContain('href="https://www.nytimes.com/by/matina-stevis-gridneff"');
    expect(html).not.toContain("mutable profile biography");
  });
});
