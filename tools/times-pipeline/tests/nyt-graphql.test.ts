import { afterEach, describe, expect, it, vi } from "vitest";
import { extractNytImages } from "../src/sources/nyt/images.js";
import {
  captureNytGraphqlPage,
  nytGraphqlArticleHtml,
  parseNytGraphqlConfig,
  resetNytGraphqlConfigCacheForTests,
} from "../src/sources/nyt/graphql.js";
import { extractNytBody } from "../src/sources/nyt/process.js";
import { sourcePageCapture } from "../src/sources/registry.js";

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
      expect.objectContaining({ role: "lead", afterBlock: undefined, caption: expect.stringContaining("Google Maps map"), credit: expect.stringContaining("map Photographer") }),
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

  it("rejects unknown non-video body blocks instead of publishing incomplete text", async () => {
    const payload = graphqlPayload() as { data: { article: { body: { content: object[] } } } };
    payload.data.article.body.content.splice(2, 0, { __typename: "DetailBlock" });
    const fetchMock = vi.fn(async (input: string | URL | Request) => String(input) === "https://www.nytimes.com/manifest.json"
      ? new Response(configHtml(), { status: 404 })
      : new Response(JSON.stringify(payload), { status: 200 }));

    await expect(captureNytGraphqlPage(PAGE_URL, 10, fetchMock as unknown as typeof fetch)).resolves.toBeUndefined();
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
