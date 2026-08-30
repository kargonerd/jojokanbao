import { gzipSync, gunzipSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runProcess } from "../src/process-cli.js";
import type { CanonicalArticle } from "../src/process/canonical-writer.js";

function translatedResponse(init: RequestInit | undefined): Response {
  const request = JSON.parse(String(init?.body)) as { contents: Array<{ parts: Array<{ text: string }> }> };
  const prompt = request.contents[0]!.parts[0]!.text;
  const input = JSON.parse(prompt.slice(prompt.indexOf("INPUT:\n") + 7)) as {
    title: string;
    blocks: Array<{ id: string; text: string }>;
  };
  const translation = {
    title: `中译：${input.title}`,
    blocks: input.blocks.map((block) => ({ id: block.id, text: `中译：${block.text}` })),
  };
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify(translation) }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 220 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Times Process translation integration", () => {
  it("translates a Raw non-Chinese article, writes Canonical metadata and reuses its cache", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "jojo-process-translation-"));
    const manifestObject = "raw/africanews/runs/2026/08/30/run/manifest.json";
    const manifestPath = path.join(output, ...manifestObject.split("/"));
    const candidatesPath = path.join(path.dirname(manifestPath), "candidates.jsonl.gz");
    const source = JSON.parse(await readFile(path.resolve("src/sources/africanews/source.json"), "utf8")) as { discovery: unknown };
    const paragraph = "This is a complete English news paragraph with enough factual context, attribution, dates, and details for canonical processing. ";
    const candidate = {
      articleId: "africanews:translation-integration",
      sourceId: "africanews",
      sourceName: "Africanews",
      language: "en",
      sourceUrl: "https://www.africanews.com/translation-integration/",
      canonicalUrl: "https://www.africanews.com/translation-integration/",
      title: "Integration story",
      discoveryBody: `<article><div class="article-content"><p>${paragraph.repeat(6)}</p></div></article>`,
      captureStatus: "captured",
      contentStatus: "full",
      publishedAt: "2026-08-30T00:00:00Z",
      authors: [],
      publisherCategories: ["News"],
      publisherSections: [{ id: "news", name: "News" }],
      assets: [],
    };
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify({
      formatVersion: "jojo-times-raw-source-run/2",
      runId: "run-translation",
      sourceId: "africanews",
      sourceName: "Africanews",
      publicationTimeZone: "Africa/Lagos",
      startedAt: "2026-08-30T00:00:00Z",
      completedAt: "2026-08-30T00:01:00Z",
      discovery: source.discovery,
      candidateCount: 1,
      fullCount: 1,
      summaryCount: 0,
      metadataCount: 0,
      networkExchangeCount: 0,
      objects: [],
      captureStatus: "page-capture-complete",
      healthStatus: "healthy",
      complete: true,
    })}\n`, "utf8");
    await writeFile(candidatesPath, gzipSync(`${JSON.stringify(candidate)}\n`));
    const runManifestPath = path.join(output, "raw", "runs", "run-translation.json");
    await mkdir(path.dirname(runManifestPath), { recursive: true });
    await writeFile(runManifestPath, `${JSON.stringify({
      runId: "run-translation",
      sources: [{ sourceId: "africanews", status: "ok", output: { manifest: manifestObject } }],
    })}\n`, "utf8");

    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => translatedResponse(init));
    vi.stubGlobal("fetch", fetchMock);
    const previousKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "integration-test-key";
    const args = new Map([
      ["config", path.resolve("sources.v2.json")],
      ["output", output],
      ["run-manifest", runManifestPath],
      ["raw-revision", "integration-revision"],
      ["translate", "true"],
      ["translation-workers", "4"],
    ]);
    try {
      const first = await runProcess(args);
      expect(first.translation).toMatchObject({ enabled: true, eligible: 1, translated: 1, cacheHits: 0, failed: 0, requests: 1 });
      const articleRef = first.sources[0]!.articles[0]!;
      const article = JSON.parse(gunzipSync(await readFile(path.join(output, ...articleRef.object.split("/")))).toString("utf8")) as CanonicalArticle;
      expect(article.translations?.["zh-CN"]).toMatchObject({
        title: "中译：Integration story",
        provider: "google-gemini-api",
        model: "gemma-4-31b-it",
      });
      expect(article.translations?.["zh-CN"]?.body.value).toContain("中译：This is a complete English news paragraph");
      expect(first.sources[0]!.files.some((objectName) => objectName.includes("/translations/gemma-news-zh-v1/"))).toBe(true);

      fetchMock.mockClear();
      const second = await runProcess(args);
      expect(second.translation).toMatchObject({ enabled: true, eligible: 1, translated: 0, cacheHits: 1, failed: 0, requests: 0 });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousKey;
    }
  });
});
