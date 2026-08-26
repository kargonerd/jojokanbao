import { describe, expect, it } from "vitest";
import { bodyWithAssets, discoverArticleImages } from "../src/capture/article-content.js";
import { unavailablePageReason } from "../src/capture/availability.js";
import { articleFingerprint, pendingArticles, type PageArticle } from "../src/capture/pending.js";
import { selectProxy, selectProxyCandidates } from "../src/capture/proxy.js";
import { groupArticlesBySource, mapSourceBatches, rotatingSourceProbes } from "../src/capture/schedule.js";

const now = new Date("2026-08-22T12:00:00Z");

function article(articleId: string, sourceId = "example", publishedAt = now.toISOString()): PageArticle {
  return {
    articleId,
    sourceId,
    title: `Headline ${articleId}`,
    canonicalUrl: `https://news.example.test/${articleId}`,
    captureUrl: `https://news.example.test/${articleId}`,
    publishedAt,
    needsBody: true,
  };
}

describe("page capture orchestration", () => {
  it("captures every pending URL without a global page limit", () => {
    const changed = article("changed");
    const deduplicated = article("deduplicated");
    const recent = article("recent");
    const values = Array.from({ length: 80 }, (_value, index) => article(`new-${index}`));
    const selected = pendingArticles(
      [recent, deduplicated, changed, ...values, article("expired", "example", "2026-08-14T12:00:00Z")],
      new Map([["example", { formatVersion: "jojo-page-capture-state/1", articles: {
        changed: { fingerprint: "different", lastAttempt: now.toISOString(), rawPageObject: "raw/example/page.json", error: null },
        deduplicated: { fingerprint: articleFingerprint(deduplicated), lastAttempt: "2026-08-21T11:00:00Z", rawPageObject: "raw/example/page.json", error: null },
        recent: { fingerprint: articleFingerprint(recent), lastAttempt: "2026-08-22T11:00:00Z", rawPageObject: "raw/example/page.json", error: null },
      } }]]),
      { now, retentionDays: 7, refreshHours: 168, retryHours: 2 },
    );
    expect(selected).toHaveLength(81);
    expect(selected.map((value) => value.articleId)).not.toContain("recent");
    expect(selected.map((value) => value.articleId)).not.toContain("deduplicated");
    expect(selected.map((value) => value.articleId)).not.toContain("expired");
  });

  it("retries a failed article on the next ten-minute schedule", () => {
    const failed = article("failed");
    const state = new Map([["example", {
      formatVersion: "jojo-page-capture-state/1" as const,
      articles: {
        failed: {
          fingerprint: articleFingerprint(failed),
          lastAttempt: "2026-08-22T11:50:30Z",
          error: "FullTextNotExtracted",
        },
      },
    }]]);
    expect(pendingArticles(
      [failed], state,
      { now, retentionDays: 7, refreshHours: 168, retryHours: 0.15 },
    ).map((value) => value.articleId)).toEqual(["failed"]);
  });

  it("keeps article images as owned asset references and filters tracking pixels", () => {
    const images = discoverArticleImages(`<html><head><meta property="og:image" content="/lead.jpg"></head><body><article>
      <p>Article body</p><figure><img src="/inside.jpg" width="1200" height="800" alt="Inside"><figcaption>Photo credit</figcaption></figure>
      <img src="/tracking-pixel.gif" width="1" height="1"></article></body></html>`, "https://example.test/story");
    expect(images.map((image) => image.sourceUrl)).toEqual([
      "https://example.test/lead.jpg",
      "https://example.test/inside.jpg",
    ]);
    expect(bodyWithAssets("<p>Body</p>", [{
      id: "asset:lead", type: "image", role: "lead", sourceUrl: images[0]!.sourceUrl,
      rawObject: "raw/example/assets/lead.jpg", mediaType: "image/jpeg", size: 1, sha256: "lead",
    }])).toBe('<figure data-asset-id="asset:lead"></figure><p>Body</p>');
  });

  it("separates non-text media and an explicit hard paywall from fetch failures", () => {
    expect(unavailablePageReason({
      sourceId: "npr", title: "Audio brief", url: "https://www.npr.org/story", html: '<body class="no-transcript">', hasFullBody: false,
    })).toBe("UnsupportedMedia");
    expect(unavailablePageReason({
      sourceId: "scmp", title: "Plus story", url: "https://www.scmp.com/plus/story", html: "SCMP Plus subscription is required for access.", hasFullBody: false,
    })).toBe("HardPaywall");
    expect(unavailablePageReason({
      sourceId: "nyt", title: "Subscriber story", url: "https://www.nytimes.com/story", hasFullBody: false,
      html: "You have a preview view of this article while we are checking your access. Subscribe for all of The Times.",
    })).toBe("HardPaywall");
    expect(unavailablePageReason({
      sourceId: "bloomberg", title: "Story", url: "https://www.bloomberg.com/news/articles/story", html: "Subscribe to continue", hasFullBody: false,
    })).toBeUndefined();
  });

  it("rotates proxy probes across the failed articles for each publisher", () => {
    const rows = [article("a-1", "a"), article("a-2", "a"), article("b-1", "b")];
    const offsets = new Map<string, number>();
    expect(rotatingSourceProbes(rows, offsets).map((row) => row.articleId)).toEqual(["a-1", "b-1"]);
    expect(rotatingSourceProbes(rows, offsets).map((row) => row.articleId)).toEqual(["a-2", "b-1"]);
    expect(rotatingSourceProbes(rows, offsets).map((row) => row.articleId)).toEqual(["a-1", "b-1"]);
  });

  it("selects healthy and spread Mihomo nodes without reusing the active route", () => {
    expect(selectProxyCandidates(
      { all: ["JOJO-TIMES-AUTO", "node-a", "node-b", "node-c", "node-d", "node-e"], now: "JOJO-TIMES-AUTO" },
      { now: "node-a" },
      { proxies: {
        "node-a": { history: [{ delay: 10 }] }, "node-b": { history: [{ delay: 20 }] },
        "node-c": { history: [{ delay: 30 }] }, "node-d": { history: [{ delay: 40 }] },
        "node-e": { history: [{ delay: 200 }] },
      } },
      "JOJO-TIMES-AUTO",
      3,
    )).toEqual(["node-b", "node-d", "node-e"]);
  });

  it("accepts Mihomo's empty 204 response when switching routes", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status: 204 });
    try {
      await expect(selectProxy("http://127.0.0.1:9090", "JOJO-TIMES-ROUTE", "node-b")).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("runs publishers concurrently without overlapping a publisher", async () => {
    const grouped = groupArticlesBySource([article("a-1", "a"), article("b-1", "b"), article("a-2", "a")]);
    expect(grouped.map((batch) => [batch.sourceId, batch.articles.map((row) => row.articleId)])).toEqual([
      ["a", ["a-1", "a-2"]], ["b", ["b-1"]],
    ]);
    let active = 0;
    let maximum = 0;
    await mapSourceBatches([...grouped.flatMap((batch) => batch.articles), article("c-1", "c")], 2, async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    });
    expect(maximum).toBe(2);
  });
});
