import { describe, expect, it } from "vitest";
import { discoverArticleImages } from "../src/capture/page-images.js";
import { attachAssetsToBody } from "../src/process/article.js";
import { unavailablePageReason } from "../src/capture/availability.js";
import { articleFingerprint, pendingArticles, selectRunArticles, type PageArticle } from "../src/capture/pending.js";
import { selectProxy, selectProxyCandidates } from "../src/capture/proxy.js";
import { groupArticlesBySource, mapSourceBatches, rotatingSourceProbes } from "../src/capture/schedule.js";
import { thepaperFetch } from "../src/sources/thepaper/fetch.js";

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

  it("recaptures successful articles after a publisher capture-policy revision", () => {
    const previous = { ...article("policy-change", "thepaper"), captureRevision: "image-body-v1" };
    const state = new Map([["thepaper", {
      formatVersion: "jojo-page-capture-state/1" as const,
      articles: {
        "policy-change": {
          fingerprint: articleFingerprint(previous),
          lastAttempt: "2026-08-22T11:50:30Z",
          rawPageObject: "raw/thepaper/page.json",
          error: null,
        },
      },
    }]]);
    const current = { ...previous, captureRevision: "image-body-v2" };

    expect(pendingArticles(
      [current], state,
      { now, retentionDays: 7, refreshHours: 168, retryHours: 2 },
    ).map((value) => value.articleId)).toEqual(["policy-change"]);
  });

  it("keeps the current process window plus unseen late arrivals", () => {
    const recent = article("recent", "example", "2026-08-22T11:30:00Z");
    const late = article("late", "example", "2026-08-21T18:00:00Z");
    const oldUnchanged = article("old-unchanged", "example", "2026-08-21T17:00:00Z");
    const state = new Map([["example", {
      formatVersion: "jojo-page-capture-state/1" as const,
      articles: {
        "old-unchanged": {
          fingerprint: articleFingerprint(oldUnchanged),
          lastAttempt: "2026-08-22T11:00:00Z",
          rawPageObject: "raw/example/page.json",
          error: null,
        },
      },
    }]]);
    const values = [recent, late, oldUnchanged];
    const pending = pendingArticles(values, state, {
      now, retentionDays: 7, refreshHours: 168, retryHours: 2,
    });
    const selected = selectRunArticles(values, pending, { now, processWindowHours: 1 });

    expect(selected.articles.map((value) => value.articleId)).toEqual(["recent", "late"]);
    expect([...selected.recoveryArticleIds]).toEqual(["late"]);
  });

  it("keeps article images as owned asset references and filters tracking pixels", () => {
    const images = discoverArticleImages(`<html><head><meta property="og:image" content="/lead.jpg"></head><body><article>
      <p>Article body</p><figure><img src="/inside.jpg" width="1200" height="800" alt="Inside"><figcaption>Photo credit</figcaption></figure>
      <img src="/tracking-pixel.gif" width="1" height="1"></article></body></html>`, "https://example.test/story");
    expect(images.map((image) => image.sourceUrl)).toEqual([
      "https://example.test/lead.jpg",
      "https://example.test/inside.jpg",
    ]);
    expect(attachAssetsToBody("<p>Body</p>", [{
      id: "asset:lead", type: "image", role: "lead", sourceUrl: images[0]!.sourceUrl,
      rawObject: "raw/example/assets/lead.jpg", mediaType: "image/jpeg", size: 1, sha256: "lead",
    }])).toBe('<figure data-asset-id="asset:lead"></figure><p>Body</p>');
  });

  it("limits The Paper assets to its hashed article-content container", () => {
    const images = discoverArticleImages(`<main>
      <img src="/navigation.png" width="400" height="400">
      <div class="cententWrap__UojXm"><img src="/report.webp" width="1022" height="3183"></div>
      <img src="/download-app.png" width="400" height="400">
    </main>`, "https://www.thepaper.cn/newsDetail_forward_33971197", thepaperFetch);

    expect(images.map((image) => image.sourceUrl)).toEqual(["https://www.thepaper.cn/report.webp"]);
  });

  it("classifies generic media URLs without mistaking text pages for hard paywalls", () => {
    expect(unavailablePageReason({
      title: "Video brief", url: "https://news.example.test/videos/brief", hasFullBody: false,
    })).toBe("UnsupportedMedia");
    expect(unavailablePageReason({
      title: "Article with video", url: "https://news.example.test/articles/story", html: "Subscribe to continue", hasFullBody: false,
    })).toBeUndefined();
    expect(unavailablePageReason({
      title: "Video with a transcript", url: "https://news.example.test/video/brief", hasFullBody: true,
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
