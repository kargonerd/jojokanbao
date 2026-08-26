import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverThepaper } from "../src/sources/thepaper/discover.js";
import type { RouteDiscoveryEndpoint, SourceConfig } from "../src/types.js";

afterEach(() => vi.unstubAllGlobals());

describe("The Paper discovery", () => {
  it("uses the publisher channel API and excludes video details", async () => {
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
      sections: [{ id: "current-affairs", name: "时事", url: "https://www.thepaper.cn/channel_25950" }],
      discovery: endpoint,
      content: { priority: ["discovery-body", "discovery-summary"], minimumFullCharacters: 20, minimumFullParagraphs: 1 },
      fetch: { strategy: "direct-first", bpc: false },
      health: { minimumCandidates: 1 },
      enabled: true,
    };
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
});
