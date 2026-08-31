import { readFile } from "node:fs/promises";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  assessArticleBody,
  extractArticleBody,
  hasArticleBody,
  selectArticleBody,
} from "../src/content/body.js";
import { allowsInRunCaptureRetry, captureWithBrowserFallback } from "../src/capture/fallback.js";
import type { CapturedHtmlPage } from "../src/capture/http.js";
import { extractAlJazeeraImages } from "../src/sources/aljazeera/images.js";
import {
  AL_JAZEERA_LIVEBLOG_COMPLETE_ATTRIBUTE,
  AL_JAZEERA_LIVEBLOG_UPDATE_ATTRIBUTE,
  captureAlJazeeraPage,
} from "../src/sources/aljazeera/capture.js";
import { alJazeeraFetch } from "../src/sources/aljazeera/fetch.js";
import { extractAlJazeeraBody } from "../src/sources/aljazeera/process.js";
import { sourcePageCapture } from "../src/sources/registry.js";

const ORDINARY_URL = "https://www.aljazeera.com/news/2026/8/31/ordinary-report";
const LIVEBLOG_URL = "https://www.aljazeera.com/news/liveblog/2026/8/31/example-live";

interface UpdateFixture {
  id: string;
  link: string;
  postType: string;
  content: string;
  date: string;
  title: string;
  shouldDisplayTitle: boolean;
}

let ordinaryHtml = "";
let liveblogHtml = "";
let updates: UpdateFixture[] = [];

beforeAll(async () => {
  ordinaryHtml = await readFile(new URL("./fixtures/aljazeera/ordinary.html", import.meta.url), "utf8");
  liveblogHtml = await readFile(new URL("./fixtures/aljazeera/liveblog.html", import.meta.url), "utf8");
  updates = JSON.parse(await readFile(new URL("./fixtures/aljazeera/liveblog-updates.json", import.meta.url), "utf8")) as UpdateFixture[];
});

afterEach(() => {
  vi.restoreAllMocks();
});

function pageResponse(html: string, finalUrl?: string): Response {
  const response = new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  if (finalUrl) Object.defineProperty(response, "url", { configurable: true, value: finalUrl });
  return response;
}

function updateResponse(update: UpdateFixture): Response {
  return new Response(JSON.stringify({ data: { posts: update } }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function updateId(input: string | URL | Request): string | undefined {
  const url = new URL(String(input));
  if (url.pathname !== "/graphql") return undefined;
  const variables = JSON.parse(url.searchParams.get("variables") ?? "{}") as { postID?: number };
  return variables.postID === undefined ? undefined : String(variables.postID);
}

function completeFetchMock(requestedIds: string[], finalUrl?: string): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === LIVEBLOG_URL) return pageResponse(liveblogHtml, finalUrl);
    const id = updateId(input);
    expect(id).toBeDefined();
    requestedIds.push(id!);
    expect(new URL(String(input)).searchParams.get("operationName")).toBe("LiveBlogUpdateQuery");
    expect(new URL(String(input)).searchParams.get("wp-site")).toBe("aje");
    expect(new Headers(init?.headers).get("wp-site")).toBe("aje");
    const update = updates.find((candidate) => candidate.id === id);
    if (!update) return new Response("missing", { status: 404 });
    return updateResponse(update);
  }) as unknown as typeof fetch;
}

function browserPage(requestedUrl: string, finalUrl: string, renderedHtml: string): CapturedHtmlPage {
  return {
    method: "browser",
    requestedUrl,
    finalUrl,
    renderedHtml,
    capturedAt: "2026-08-31T00:00:00.000Z",
  };
}

function productionHasBody(page: CapturedHtmlPage): boolean {
  return page.renderedHtml
    ? hasArticleBody(
        page.renderedHtml,
        alJazeeraFetch,
        { minimumCharacters: 1_000, minimumParagraphs: 5 },
        extractAlJazeeraBody,
        page.finalUrl,
      )
    : false;
}

function plausibleButIncompleteLiveblog(): string {
  const extra = Array.from({ length: 6 }, (_, index) => (
    `<p>Introductory liveblog material ${index + 1}: ${"This is plausible publisher reporting, but the official child inventory has not been materialized. ".repeat(3)}</p>`
  )).join("");
  return liveblogHtml.replace(
    "</header>",
    `</header><section data-component="live-blog-post"><div class="wysiwyg">${extra}</div></section>`,
  );
}

function rewriteApolloState(
  html: string,
  rewrite: (state: Record<string, any>) => void,
): string {
  const match = html.match(/window\.__APOLLO_STATE__="([A-Za-z0-9+/=_-]+)"/u);
  if (!match?.[1]) throw new Error("fixture Apollo state missing");
  const state = JSON.parse(Buffer.from(match[1], "base64").toString("utf8")) as Record<string, any>;
  rewrite(state);
  return html.replace(match[1], Buffer.from(JSON.stringify(state)).toString("base64"));
}

describe("Al Jazeera publisher page capture", () => {
  it("keeps a complete ordinary server-rendered article on the direct path", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe(ORDINARY_URL);
      return pageResponse(ordinaryHtml);
    });

    let browserCalls = 0;
    const page = await captureWithBrowserFallback({
      direct: () => captureAlJazeeraPage(ORDINARY_URL, 10, fetchMock as unknown as typeof fetch),
      browser: async () => {
        browserCalls += 1;
        return browserPage(ORDINARY_URL, ORDINARY_URL, ordinaryHtml);
      },
      hasBody: productionHasBody,
    });

    expect(page).toMatchObject({ method: "direct", status: 200, finalUrl: ORDINARY_URL });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(browserCalls).toBe(0);
    const quality = { minimumCharacters: 1_000, minimumParagraphs: 5 };
    const body = extractArticleBody(
      page?.renderedHtml ?? "",
      alJazeeraFetch,
      quality,
      extractAlJazeeraBody,
      ORDINARY_URL,
    );
    expect(body).toContain("publisher source link");
    expect(body).toContain("actual end of this ordinary Al Jazeera article");
    expect(assessArticleBody(
      page?.renderedHtml ?? "",
      alJazeeraFetch,
      quality,
      extractAlJazeeraBody,
      ORDINARY_URL,
      "captured-page",
    )).toMatchObject({ extractionPath: "publisher-extractor-legacy", completeness: "unknown", verdict: "accepted" });
  });

  it("fetches every SSR child in publisher order and injects body and image containers understood by the extractors", async () => {
    const requestedIds: string[] = [];

    let browserCalls = 0;
    const page = await captureWithBrowserFallback({
      direct: () => captureAlJazeeraPage(LIVEBLOG_URL, 10, completeFetchMock(requestedIds)),
      browser: async () => {
        browserCalls += 1;
        return browserPage(LIVEBLOG_URL, LIVEBLOG_URL, liveblogHtml);
      },
      hasBody: productionHasBody,
    });

    expect(page).toMatchObject({ method: "direct", status: 200, finalUrl: LIVEBLOG_URL });
    expect(browserCalls).toBe(0);
    expect(requestedIds).toEqual(["9003", "9002", "9001"]);
    const html = page?.renderedHtml ?? "";
    expect(html).toContain(`${AL_JAZEERA_LIVEBLOG_COMPLETE_ATTRIBUTE}="9000"`);
    expect([...html.matchAll(new RegExp(`${AL_JAZEERA_LIVEBLOG_UPDATE_ATTRIBUTE}="(\\d+)"`, "gu"))]
      .map((match) => match[1])).toEqual(["9003", "9002", "9001"]);

    const quality = { minimumCharacters: 1_000, minimumParagraphs: 5 };
    const body = extractArticleBody(html, alJazeeraFetch, quality, extractAlJazeeraBody, LIVEBLOG_URL) ?? "";
    expect(hasArticleBody(html, alJazeeraFetch, quality, extractAlJazeeraBody, LIVEBLOG_URL)).toBe(true);
    expect(assessArticleBody(
      html,
      alJazeeraFetch,
      quality,
      extractAlJazeeraBody,
      LIVEBLOG_URL,
      "captured-page",
    )).toMatchObject({
      extractionPath: "publisher-extractor",
      completeness: "publisher-complete",
      verdict: "accepted",
      evidence: {
        kind: "liveblog-inventory",
        reason: "complete",
        liveblogId: "9000",
        expectedChildCount: 3,
        capturedChildCount: 3,
        childOrderVerified: true,
      },
    });
    expect(body.indexOf("Latest verified development")).toBeLessThan(body.indexOf("Background and map"));
    expect(body.indexOf("Background and map")).toBeLessThan(body.indexOf("Welcome to the liveblog"));
    expect(body).toContain("Officials confirmed the first material fact");
    expect(body).toContain("Reporting continues after the image");
    const missingChildMarker = html.replace(
      `${AL_JAZEERA_LIVEBLOG_UPDATE_ATTRIBUTE}="9002"`,
      `${AL_JAZEERA_LIVEBLOG_UPDATE_ATTRIBUTE}="missing"`,
    );
    expect(extractAlJazeeraBody(
      missingChildMarker,
      quality,
      LIVEBLOG_URL,
    )).toMatchObject({
      completeness: "truncated",
      evidence: { kind: "liveblog-inventory", reason: "child-inventory-mismatch", childOrderVerified: false },
    });

    expect(extractAlJazeeraImages(html, LIVEBLOG_URL)).toEqual([
      expect.objectContaining({
        sourceUrl: "https://www.aljazeera.com/wp-content/uploads/live-map.jpg",
        role: "content",
        afterBlock: 10,
        alt: "Live map",
        caption: "Map supplied with the live update",
        width: 1200,
        height: 800,
      }),
    ]);
  });

  it("fails closed when any required GraphQL child request fails and refuses the SSR intro as full text", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === LIVEBLOG_URL) return pageResponse(liveblogHtml);
      const id = updateId(input);
      if (id === "9002") return new Response("unavailable", { status: 503 });
      const update = updates.find((candidate) => candidate.id === id)!;
      return updateResponse(update);
    });

    await expect(captureAlJazeeraPage(LIVEBLOG_URL, 10, fetchMock as unknown as typeof fetch)).resolves.toBeUndefined();
    expect(extractAlJazeeraBody(
      liveblogHtml,
      { minimumCharacters: 10, minimumParagraphs: 1 },
      LIVEBLOG_URL,
    )).toMatchObject({
      completeness: "truncated",
      evidence: { kind: "liveblog-inventory", reason: "complete-marker-missing-or-duplicate" },
    });
  });

  it("makes an incomplete liveblog terminal on the production body-selection paths", () => {
    const partial = plausibleButIncompleteLiveblog();
    const quality = { minimumCharacters: 1_000, minimumParagraphs: 5 };

    // Control: this page is deliberately long enough for the generic `main`
    // selector, reproducing the fallback that previously accepted the intro.
    expect(hasArticleBody(partial, alJazeeraFetch, quality, undefined, LIVEBLOG_URL)).toBe(true);
    expect(extractArticleBody(partial, alJazeeraFetch, quality, extractAlJazeeraBody, LIVEBLOG_URL)).toBeUndefined();
    expect(hasArticleBody(partial, alJazeeraFetch, quality, extractAlJazeeraBody, LIVEBLOG_URL)).toBe(false);
    expect(assessArticleBody(
      partial,
      alJazeeraFetch,
      quality,
      extractAlJazeeraBody,
      LIVEBLOG_URL,
      "captured-page",
    )).toMatchObject({
      extractionPath: "publisher-extractor",
      completeness: "truncated",
      verdict: "rejected",
      rejectReason: "publisher-truncated",
      evidence: { reason: "complete-marker-missing-or-duplicate", expectedChildCount: 3 },
    });

    const selected = selectArticleBody({
      capturedPage: { html: partial, pageUrl: LIVEBLOG_URL },
      discoveryBody: { html: ordinaryHtml, pageUrl: ORDINARY_URL },
    }, alJazeeraFetch, quality, extractAlJazeeraBody);
    expect(selected.body).toBeUndefined();
    expect(selected.report.attempts).toHaveLength(1);
    expect(selected.report.attempts[0]).toMatchObject({ rejectReason: "publisher-truncated" });
  });

  it("rejects an incomplete SSR child inventory instead of treating it as an ordinary page", async () => {
    const incompleteHtml = rewriteApolloState(liveblogHtml, (state) => {
      state["Post:9000"].childrenMeta.pop();
    });
    const fetchMock = vi.fn(async () => pageResponse(incompleteHtml));

    let browserCalls = 0;
    const page = await captureWithBrowserFallback({
      direct: () => captureAlJazeeraPage(LIVEBLOG_URL, 10, fetchMock as unknown as typeof fetch),
      browser: async () => {
        browserCalls += 1;
        return browserPage(LIVEBLOG_URL, LIVEBLOG_URL, incompleteHtml);
      },
      hasBody: productionHasBody,
    });
    expect(page.method).toBe("browser");
    expect(browserCalls).toBe(1);
    expect(productionHasBody(page)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(extractAlJazeeraBody(
      incompleteHtml,
      { minimumCharacters: 1_000, minimumParagraphs: 5 },
      LIVEBLOG_URL,
    )).toMatchObject({
      completeness: "truncated",
      evidence: { reason: "descriptor-missing", expectedChildCount: 0 },
    });
  });

  it("makes liveblog cross-article redirects terminal before browser or generic fallback", async () => {
    const redirectedUrls = [
      ORDINARY_URL,
      "https://www.aljazeera.com/news/liveblog/2026/8/31/a-different-liveblog",
    ];
    expect(productionHasBody(browserPage(LIVEBLOG_URL, ORDINARY_URL, ordinaryHtml))).toBe(true);
    for (const redirectedUrl of redirectedUrls) {
      const redirectFetch = vi.fn(async () => pageResponse(
        redirectedUrl === ORDINARY_URL ? ordinaryHtml : liveblogHtml,
        redirectedUrl,
      ));
      let browserCalls = 0;
      const page = await captureWithBrowserFallback({
        direct: () => captureAlJazeeraPage(
          LIVEBLOG_URL,
          10,
          redirectFetch as unknown as typeof fetch,
        ),
        browser: async () => {
          browserCalls += 1;
          return browserPage(
            LIVEBLOG_URL,
            redirectedUrl,
            redirectedUrl === ORDINARY_URL ? ordinaryHtml : liveblogHtml,
          );
        },
        hasBody: productionHasBody,
      });

      expect(page).toMatchObject({
        method: "direct",
        requestedUrl: LIVEBLOG_URL,
        finalUrl: redirectedUrl,
        error: "AlJazeeraLiveblogRedirectMismatch",
        browserFallback: "forbidden",
      });
      expect(page.renderedHtml).toBeUndefined();
      expect(browserCalls).toBe(0);
      expect(redirectFetch).toHaveBeenCalledTimes(1);
      expect(allowsInRunCaptureRetry(page)).toBe(false);
      if (redirectedUrl === ORDINARY_URL) {
        const selection = selectArticleBody({
          discoveryBody: { html: ordinaryHtml, pageUrl: LIVEBLOG_URL },
        }, alJazeeraFetch, { minimumCharacters: 1_000, minimumParagraphs: 5 }, extractAlJazeeraBody);
        expect(selection.body).toBeUndefined();
        expect(selection.report.attempts[0]).toMatchObject({
          completeness: "truncated",
          rejectReason: "publisher-truncated",
        });
      }
    }
  });

  it("allows a trailing slash while keeping the complete liveblog on the direct path", async () => {

    const requestedIds: string[] = [];
    let browserCalls = 0;
    const captured = await captureWithBrowserFallback({
      direct: () => captureAlJazeeraPage(
        LIVEBLOG_URL,
        10,
        completeFetchMock(requestedIds, `${LIVEBLOG_URL}/`),
      ),
      browser: async () => {
        browserCalls += 1;
        return browserPage(LIVEBLOG_URL, `${LIVEBLOG_URL}/`, liveblogHtml);
      },
      hasBody: productionHasBody,
    });
    expect(captured?.finalUrl).toBe(`${LIVEBLOG_URL}/`);
    expect(requestedIds).toEqual(["9003", "9002", "9001"]);
    expect(browserCalls).toBe(0);
  });

  it("rejects a mismatched GraphQL child response and exposes the publisher capture through the source registry", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === LIVEBLOG_URL) return pageResponse(liveblogHtml);
      const id = updateId(input);
      const update = { ...updates.find((candidate) => candidate.id === id)!, id: id === "9002" ? "9999" : id! };
      return updateResponse(update);
    });

    await expect(captureAlJazeeraPage(LIVEBLOG_URL, 10, fetchMock as unknown as typeof fetch)).resolves.toBeUndefined();
    expect(sourcePageCapture("aljazeera")).toBeTypeOf("function");
    expect(alJazeeraFetch.revision).toBe("publisher-content-v3");
  });
});
