import { describe, expect, it } from "vitest";
import { extractRenderedBody } from "../src/archive/body.js";
import { BROWSERTRIX_IMAGE, browsertrixArguments } from "../src/archive/browsertrix.js";
import { selectProxy, selectProxyCandidates } from "../src/archive/proxy.js";
import { groupArticlesBySource, mapSourceBatches } from "../src/archive/schedule.js";
import { articleFingerprint, selectArticlesForCapture, type ArchiveArticle } from "../src/archive/select.js";

const now = new Date("2026-08-22T12:00:00Z");

function article(articleId: string, sourceId = "example", publishedAt = now.toISOString()): ArchiveArticle {
  return {
    articleId,
    sourceId,
    title: `Headline ${articleId}`,
    canonicalUrl: `https://news.example.test/${articleId}`,
    captureUrl: `https://news.example.test/${articleId}`,
    publishedAt,
  };
}

describe("browser archive orchestration", () => {
  it("prioritizes new and changed pages, then due refreshes", () => {
    const changed = article("changed");
    const refresh = article("refresh");
    const recent = article("recent");
    const selected = selectArticlesForCapture(
      [recent, refresh, changed, article("new"), article("expired", "example", "2026-08-14T12:00:00Z")],
      { formatVersion: "jojo-web-archive-state/1", articles: {
        changed: { fingerprint: "different", lastAttempt: now.toISOString(), httpStatus: 200 },
        refresh: { fingerprint: articleFingerprint(refresh), lastAttempt: "2026-08-21T11:00:00Z", httpStatus: 200 },
        recent: { fingerprint: articleFingerprint(recent), lastAttempt: "2026-08-22T11:00:00Z", httpStatus: 200 },
      } },
      { now, retentionDays: 7, maximumPages: 3, refreshHours: 24, retryHours: 2 },
    );

    expect(selected.map((value) => value.articleId)).toEqual(["new", "changed", "refresh"]);
  });

  it("represents each publisher before filling remaining slots", () => {
    const selected = selectArticlesForCapture(
      [article("newest"), article("older", "example", "2026-08-22T11:59:00Z"), article("other", "second", "2026-08-22T11:58:00Z")],
      { formatVersion: "jojo-web-archive-state/1", articles: {} },
      { now, retentionDays: 7, maximumPages: 2, refreshHours: 24, retryHours: 2 },
    );

    expect(selected.map((value) => value.articleId)).toEqual(["newest", "other"]);
  });

  it("fills remaining slots with missing bodies before archive-only pages", () => {
    const alreadyFull = article("already-full", "first", "2026-08-22T12:00:00Z");
    const missingOlder = { ...article("missing-older", "first", "2026-08-22T11:00:00Z"), needsBody: true };
    const otherSource = article("other-source", "second", "2026-08-22T10:00:00Z");
    const selected = selectArticlesForCapture(
      [alreadyFull, missingOlder, otherSource],
      { formatVersion: "jojo-web-archive-state/1", articles: {} },
      { now, retentionDays: 7, maximumPages: 3, refreshHours: 24, retryHours: 2 },
    );

    expect(selected.map((value) => value.articleId)).toEqual(["missing-older", "other-source", "already-full"]);
  });

  it("selects fast and spread Mihomo nodes without reusing the active route", () => {
    const selected = selectProxyCandidates(
      { all: ["JOJO-TIMES-AUTO", "node-a", "node-b", "node-c", "node-d", "node-e", "node-f"], now: "JOJO-TIMES-AUTO" },
      { now: "node-a" },
      { proxies: {
        "node-a": { history: [{ delay: 10 }] },
        "node-b": { history: [{ delay: 20 }] },
        "node-c": { history: [{ delay: 30 }] },
        "node-d": { history: [{ delay: 40 }] },
        "node-e": { history: [{ delay: 200 }] },
        "node-f": { history: [{ delay: 300 }] },
      } },
      "JOJO-TIMES-AUTO",
      4,
    );

    expect(selected).toEqual(["node-b", "node-c", "node-d", "node-e"]);
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

  it("extracts only Reuters-owned paragraph and list blocks from rendered DOM", () => {
    const intro = `<div data-testid="paragraph-0">${"Reuters introduction. ".repeat(20)}</div>`;
    const details = Array.from({ length: 4 }, (_, index) =>
      `<div data-testid="unordered-0"><div data-testid="Body">${`Article detail ${index}. `.repeat(15)}</div></div>`
    ).join("");
    const unrelated = '<div data-testid="Body">Company widget that must not be included.</div>';
    const body = extractRenderedBody(`<html><body>${intro}${details}${unrelated}</body></html>`, {
      capture: "browser",
      bodySelectors: [
        "[data-testid^='paragraph-'], [data-testid^='unordered-'] [data-testid='Body'], [data-testid='SignOff'] [data-testid='Body']",
      ],
    });

    expect(body?.match(/<p>/gu)).toHaveLength(5);
    expect(body).not.toContain("Company widget");
  });

  it("uses the source's quality threshold for short complete news articles", () => {
    const body = extractRenderedBody("<article><p>这是一篇完整但很短的快讯正文，来源会明确允许单段短稿进入全文。</p></article>", undefined, {
      minimumCharacters: 20,
      minimumParagraphs: 1,
    });

    expect(body).toContain("完整但很短的快讯正文");
  });

  it("uses the complete source-owned container when an article mixes paragraphs and text nodes", () => {
    const body = extractRenderedBody(
      `<div id="publisher-body">${"正文直接文本。".repeat(30)}<p>来源信息不会让直接文本丢失。</p></div>`,
      { capture: "browser", bodySelectors: ["#publisher-body"] },
      { minimumCharacters: 100, minimumParagraphs: 1 },
    );

    expect(body).toContain("正文直接文本");
  });

  it("pins Browsertrix and mounts BPC without passing secrets into the container", () => {
    const args = browsertrixArguments({
      workspace: "/workspace",
      temporaryRoot: "/tmp/crawl",
      rawArchiveRoot: "/workspace/raw/web-archives/times",
      runId: "run",
      round: 0,
      sourceId: "example",
      articles: [article("one")],
      timeoutSeconds: 25,
      proxyServer: "http://127.0.0.1:7890",
      extensionPath: "/workspace/bpc",
      driverPath: "/workspace/driver.mjs",
    });

    expect(BROWSERTRIX_IMAGE).toMatch(/^webrecorder\/browsertrix-crawler:1\.14\.1@sha256:[a-f0-9]{64}$/u);
    expect(args).toContain("--extraChromeArgs=--load-extension=/jojo/bpc");
    expect(args).toContain("--proxyServer=http://127.0.0.1:7890");
    expect(args).toContain("--workers=1");
    expect(args.join(" ")).not.toContain("subscription");
  });

  it("groups every publisher into one serial Browsertrix batch", () => {
    const batches = groupArticlesBySource([
      article("a-1", "a"),
      article("b-1", "b"),
      article("a-2", "a"),
      article("c-1", "c"),
      article("b-2", "b"),
    ]);

    expect(batches.map((batch) => [batch.sourceId, batch.articles.map((row) => row.articleId)])).toEqual([
      ["a", ["a-1", "a-2"]],
      ["b", ["b-1", "b-2"]],
      ["c", ["c-1"]],
    ]);
  });

  it("runs publishers concurrently without overlapping a publisher", async () => {
    let activeSources = 0;
    let maximumActiveSources = 0;
    const seen: string[][] = [];
    await mapSourceBatches([
      article("a-1", "a"),
      article("a-2", "a"),
      article("b-1", "b"),
      article("c-1", "c"),
    ], 2, async (batch) => {
      activeSources += 1;
      maximumActiveSources = Math.max(maximumActiveSources, activeSources);
      seen.push(batch.articles.map((row) => row.articleId));
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeSources -= 1;
    });

    expect(maximumActiveSources).toBe(2);
    expect(seen).toContainEqual(["a-1", "a-2"]);
    expect(seen).toContainEqual(["b-1"]);
    expect(seen).toContainEqual(["c-1"]);
  });
});
