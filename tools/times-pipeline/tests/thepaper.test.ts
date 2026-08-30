import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverThepaper } from "../src/sources/thepaper/discover.js";
import type { RouteDiscoveryEndpoint, SourceConfig } from "../src/types.js";

afterEach(() => vi.unstubAllGlobals());

function fixture(): { endpoint: RouteDiscoveryEndpoint; source: SourceConfig } {
  const endpoint: RouteDiscoveryEndpoint = {
    kind: "source-adapter",
    adapter: "thepaper",
    driver: "http",
    route: "current-affairs",
    maximumItems: 20,
  };
  const source: SourceConfig = {
    id: "thepaper",
    name: "澎湃新闻",
    language: "zh-CN",
    publicationTimeZone: "Asia/Shanghai",
    sections: [{ id: "current-affairs", name: "时事", url: "https://www.thepaper.cn/channel_25950" }],
    discovery: endpoint,
    content: { priority: ["discovery-body", "discovery-summary"], minimumFullCharacters: 20, minimumFullParagraphs: 1 },
    fetch: { strategy: "direct-first", bpc: false },
    health: { minimumCandidates: 1 },
    enabled: true,
  };
  return { endpoint, source };
}

describe("The Paper discovery", () => {
  it("uses the publisher channel API and excludes video details", async () => {
    const { endpoint, source } = fixture();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("getByChannelId")) {
        return Response.json({ data: { list: [
          { contId: "one", name: "One", pubTimeLong: 1_787_634_600_000 },
          { contId: "video", name: "Video", pubTimeLong: 1_787_634_600_000 },
        ] } });
      }
      const video = url.endsWith("/video");
      return new Response(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
        props: { pageProps: { detailData: { contentDetail: {
          name: video ? "Video" : "One",
          publishTime: 1_787_634_600_000,
          content: "<p>This is a complete article body for The Paper adapter test.</p>",
          summary: "Summary",
          author: "Reporter",
          nodeInfo: { name: "时事" },
          tagList: [{ tag: "法律" }],
          videoDTOList: video ? [{ url: "https://video.test/one.mp4" }] : [],
        } } } },
      })}</script>`, { status: 200 });
    }));

    const result = await discoverThepaper(source, endpoint, "2026-08-25T05:10:00Z");

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      canonicalUrl: "https://www.thepaper.cn/newsDetail_forward_one",
      contentStatus: "full",
      publisherCategories: ["时事", "法律"],
    });
    expect(result.upstream).toMatchObject({ skippedVideoCount: 1, channelId: "25950" });
  });

  it("follows the channel startTime cursor, deduplicates rows, and stops on a repeated cursor", async () => {
    const { endpoint, source } = fixture();
    const channelBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("getByChannelId")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        channelBodies.push(body);
        if (body.startTime === undefined) {
          return Response.json({ data: {
            list: [{ contId: "first", name: "First", pubTimeLong: 1_787_634_600_000 }],
            hasNext: true,
            startTime: 1_787_634_500_000,
          } });
        }
        return Response.json({ data: {
          list: [
            { contId: "first", name: "Duplicate", pubTimeLong: 1_787_634_600_000 },
            { contId: "33975101", name: "Second-page sample", pubTimeLong: 1_787_634_400_000 },
          ],
          hasNext: true,
          startTime: 1_787_634_500_000,
        } });
      }
      const contId = url.split("/").at(-1);
      return new Response(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
        props: { pageProps: { detailData: { contentDetail: {
          name: contId === "33975101" ? "Second-page sample" : "First",
          publishTime: 1_787_634_600_000,
          content: "<p>This is a complete article body for The Paper pagination test.</p>",
        } } } },
      })}</script>`, { status: 200 });
    }));

    const result = await discoverThepaper(source, endpoint, "2026-08-25T05:10:00Z");

    expect(channelBodies).toEqual([
      { channelId: "25950" },
      { channelId: "25950", startTime: 1_787_634_500_000 },
    ]);
    expect(result.candidates.map((candidate) => candidate.upstreamId)).toEqual(["first", "33975101"]);
    expect(result.upstream).toMatchObject({ channelPageCount: 2, articleIds: ["first", "33975101"] });
  });
});
