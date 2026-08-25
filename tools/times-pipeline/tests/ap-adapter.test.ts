import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverSource } from "../src/discovery/multi.js";
import type { SourceConfig } from "../src/types.js";

const source: SourceConfig = {
  id: "ap",
  name: "AP News",
  language: "en",
  sections: [{ id: "world", name: "World", url: "https://apnews.com/world-news", kind: "region" }],
  discovery: {
    kind: "multi",
    targets: [{
      id: "world",
      sectionIds: ["world"],
      discovery: {
        kind: "source-adapter",
        adapter: "ap",
        driver: "http",
        path: "/world-news",
        maximumItems: 20,
      },
    }],
  },
  content: { priority: ["browser-parser", "discovery-summary"], parser: "ap" },
  archive: { mode: "browser", bpc: true },
  health: { minimumCandidates: 1 },
  enabled: true,
};

afterEach(() => vi.unstubAllGlobals());

describe("AP source adapter", () => {
  it("discovers article metadata from the AP persisted GraphQL query", async () => {
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0]) => new Response(JSON.stringify({
      data: {
        Screen: {
          main: [{
            __typename: "ColumnContainer",
            columns: [{
              __typename: "PageListModule",
              items: [
                {
                  __typename: "PagePromo",
                  id: "story-1",
                  title: "World headline",
                  url: "/article/world-headline",
                  publishDateStamp: "2026-08-25T04:00:00Z",
                  description: "A concise AP summary.",
                  category: "World",
                },
                {
                  __typename: "PagePromo",
                  id: "story-without-date",
                  title: "Undated story",
                  url: "/article/undated",
                },
              ],
            }],
          }],
        },
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await discoverSource(source, "2026-08-25T04:10:00Z", Date.parse("2026-08-24T04:10:00Z"));

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toEqual(expect.objectContaining({
      canonicalUrl: "https://apnews.com/article/world-headline",
      title: "World headline",
      summary: "A concise AP summary.",
      contentStatus: "summary",
      publisherCategories: ["World"],
      publisherSections: [{ id: "world", name: "World" }],
      upstreamId: "story-1",
    }));
    const requested = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(JSON.parse(requested.searchParams.get("variables") ?? "{}")).toEqual({ path: "/world-news" });
  });

  it("keeps a browser driver extension point without enabling it by default", async () => {
    const browserSource: SourceConfig = {
      ...source,
      discovery: {
        kind: "source-adapter",
        adapter: "ap",
        driver: "browser",
        path: "/world-news",
        maximumItems: 20,
      },
    };

    await expect(discoverSource(browserSource, "2026-08-25T04:10:00Z", 0))
      .rejects.toThrow("browser discovery runtime is not configured");

    const open = vi.fn();
    await expect(discoverSource(browserSource, "2026-08-25T04:10:00Z", 0, { browser: { open } }))
      .rejects.toThrow("ap does not support browser discovery");
    expect(open).not.toHaveBeenCalled();
  });
});
