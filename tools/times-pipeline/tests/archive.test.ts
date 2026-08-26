import { describe, expect, it } from "vitest";
import { extractRenderedBody } from "../src/archive/body.js";
import { BROWSERTRIX_IMAGE, browsertrixArguments } from "../src/archive/browsertrix.js";
import { selectProxy, selectProxyCandidates } from "../src/archive/proxy.js";
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

  it("pins Browsertrix and mounts BPC without passing secrets into the container", () => {
    const args = browsertrixArguments({
      workspace: "/workspace",
      temporaryRoot: "/tmp/crawl",
      rawArchiveRoot: "/workspace/raw/web-archives/times",
      runId: "run",
      round: 0,
      articles: [article("one")],
      workers: 2,
      timeoutSeconds: 25,
      proxyServer: "http://127.0.0.1:7890",
      extensionPath: "/workspace/bpc",
      driverPath: "/workspace/driver.mjs",
    });

    expect(BROWSERTRIX_IMAGE).toMatch(/^webrecorder\/browsertrix-crawler:1\.14\.1@sha256:[a-f0-9]{64}$/u);
    expect(args).toContain("--extraChromeArgs=--load-extension=/jojo/bpc");
    expect(args).toContain("--proxyServer=http://127.0.0.1:7890");
    expect(args.join(" ")).not.toContain("subscription");
  });
});
