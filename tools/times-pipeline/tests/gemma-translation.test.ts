import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ProcessedCandidate } from "../src/process/article.js";
import {
  applyArticleTranslation,
  extractArticleTranslationBlocks,
  TIMES_TRANSLATION_DEFAULTS,
  translateProcessedCandidates,
} from "../src/translation/gemma.js";

function candidate(id: string, language = "en"): ProcessedCandidate {
  return {
    articleId: `wire:${id}`,
    sourceId: "wire",
    sourceName: "Wire",
    language,
    sourceUrl: `https://example.test/${id}`,
    canonicalUrl: `https://example.test/${id}`,
    title: `Story ${id}`,
    processedBody: '<figure data-asset-id="lead"><figcaption>Lead image</figcaption></figure><p>First <a href="https://example.test">paragraph</a> has 2026 facts.</p><ul><li>Second block</li></ul>',
    contentStatus: "full",
    assets: [],
    publishedAt: "2026-08-30T00:00:00Z",
    authors: [],
    publisherCategories: [],
  };
}

function translatedResponse(init: RequestInit | undefined): Response {
  const request = JSON.parse(String(init?.body)) as { contents: Array<{ parts: Array<{ text: string }> }> };
  const prompt = request.contents[0]!.parts[0]!.text;
  const input = JSON.parse(prompt.slice(prompt.indexOf("INPUT:\n") + 7)) as {
    title: string;
    blocks: Array<{ id: string; text: string }>;
  };
  const payload = {
    title: `中译：${input.title}`,
    blocks: input.blocks.map((block) => ({ id: block.id, text: `中译：${block.text}` })),
  };
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 80 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("Gemma production translation", () => {
  it("keeps production concurrency, quota headroom, chunking and timeouts explicit", () => {
    expect(TIMES_TRANSLATION_DEFAULTS).toEqual({
      workers: 8,
      requestTimeoutMs: 240_000,
      batchTimeoutMs: 720_000,
      maxChunkCharacters: 20_000,
      requestsPerMinute: 28,
      tokensPerMinute: 14_000,
    });
  });

  it("extracts leaf blocks and safely applies translated text while retaining article structure", () => {
    const body = '<blockquote><p>Quoted <strong>text</strong></p></blockquote><figure data-asset-id="lead"><figcaption>Caption</figcaption></figure>';
    expect(extractArticleTranslationBlocks(body)).toEqual([
      { id: "b1", tag: "p", text: "Quoted [[JOJO_INLINE_i1_START]]text[[JOJO_INLINE_i1_END]]" },
      { id: "b2", tag: "figcaption", text: "Caption" },
    ]);
    expect(applyArticleTranslation(body, [
      { id: "b1", text: "译文 [[JOJO_INLINE_i1_START]]<不会成为标签>[[JOJO_INLINE_i1_END]]" },
      { id: "b2", text: "图片说明" },
    ])).toBe('<blockquote><p>译文 <strong>&lt;不会成为标签&gt;</strong></p></blockquote><figure data-asset-id="lead"><figcaption>图片说明</figcaption></figure>');
  });

  it("rejects changed inline markers instead of silently dropping article links", () => {
    const body = '<p>Read <a href="https://example.test/story">the full story</a>.</p>';
    expect(() => applyArticleTranslation(body, [{ id: "b1", text: "阅读全文。" }])).toThrow("changed inline element markers");
    expect(applyArticleTranslation(body, [{
      id: "b1",
      text: "阅读[[JOJO_INLINE_i1_START]]完整报道[[JOJO_INLINE_i1_END]]。",
    }])).toBe('<p>阅读<a href="https://example.test/story">完整报道</a>。</p>');
  });

  it("translates with bounded concurrency and reuses the content-addressed cache", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "jojo-gemma-cache-"));
    let active = 0;
    let maximumActive = 0;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return translatedResponse(init);
    });
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const values = Array.from({ length: 6 }, (_value, index) => candidate(String(index + 1)));
    const first = await translateProcessedCandidates(output, values, {
      apiKey: "test-key",
      workers: 3,
      requestsPerMinute: 100,
      tokensPerMinute: 1_000_000,
      fetchImpl,
      now: () => new Date("2026-08-30T01:00:00Z"),
    });
    expect(first.stats).toMatchObject({ eligible: 6, translated: 6, cacheHits: 0, failed: 0, requests: 6 });
    expect(maximumActive).toBe(3);
    expect(first.candidates[0]?.translation).toMatchObject({
      title: "中译：Story 1",
      language: "zh-CN",
      model: "gemma-4-31b-it",
      translatedAt: "2026-08-30T01:00:00.000Z",
    });
    expect(first.candidates[0]?.translation?.body.value).toContain('中译：First <a href="https://example.test">paragraph</a> has 2026 facts.');
    expect(first.candidates[0]?.translation?.body.value).toContain('figure data-asset-id="lead"');
    const cacheObject = first.candidates[0]!.translationCacheObject!;
    const cache = JSON.parse(gunzipSync(await readFile(path.join(output, ...cacheObject.split("/")))).toString("utf8")) as { sourceHash: string };
    expect(cache.sourceHash).toBe(first.candidates[0]?.translation?.sourceHash);

    fetchMock.mockClear();
    const second = await translateProcessedCandidates(output, values, {
      apiKey: "test-key",
      workers: 3,
      requestsPerMinute: 100,
      tokensPerMinute: 1_000_000,
      fetchImpl,
    });
    expect(second.stats).toMatchObject({ eligible: 6, translated: 0, cacheHits: 6, failed: 0, requests: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back per chunk from 31B to 26B without failing the article", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "jojo-gemma-fallback-"));
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => (
      String(input).includes("gemma-4-31b-it")
        ? new Response(JSON.stringify({ error: { message: "high demand" } }), { status: 503 })
        : translatedResponse(init)
    )) as typeof fetch;
    const result = await translateProcessedCandidates(output, [candidate("fallback")], {
      apiKey: "test-key",
      fetchImpl,
      requestsPerMinute: 100,
      tokensPerMinute: 1_000_000,
    });
    expect(result.stats).toMatchObject({ translated: 1, failed: 0, requests: 2, fallbackChunks: 1 });
    expect(result.candidates[0]?.translation?.model).toBe("gemma-4-26b-a4b-it");
  });

  it("falls back per chunk when the primary model changes inline markers", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "jojo-gemma-marker-fallback-"));
    const primaryResponse = (init: RequestInit | undefined): Response => {
      const request = JSON.parse(String(init?.body)) as { contents: Array<{ parts: Array<{ text: string }> }> };
      const prompt = request.contents[0]!.parts[0]!.text;
      const input = JSON.parse(prompt.slice(prompt.indexOf("INPUT:\n") + 7)) as {
        title: string;
        blocks: Array<{ id: string; text: string }>;
      };
      return new Response(JSON.stringify({
        candidates: [{
          content: { parts: [{ text: JSON.stringify({
            title: `中译：${input.title}`,
            blocks: input.blocks.map((block) => ({
              id: block.id,
              text: `中译：${block.text.replace(/\[\[JOJO_INLINE_[^\]]+\]\]/gu, "")}`,
            })),
          }) }] },
          finishReason: "STOP",
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => (
      String(input).includes("gemma-4-31b-it") ? primaryResponse(init) : translatedResponse(init)
    )) as typeof fetch;

    const value = {
      ...candidate("marker-fallback"),
      processedBody: [
        '<p>First <a href="https://example.test/first">linked paragraph</a> keeps its URL.</p>',
        '<p>Second <strong>emphasized paragraph</strong> keeps its formatting.</p>',
      ].join(""),
    };
    const result = await translateProcessedCandidates(output, [value], {
      apiKey: "test-key",
      fetchImpl,
      maxChunkCharacters: 100,
      requestsPerMinute: 100,
      tokensPerMinute: 1_000_000,
    });

    expect(result.stats).toMatchObject({ translated: 1, failed: 0, requests: 4, fallbackChunks: 2 });
    expect(result.candidates[0]?.translation?.model).toBe("gemma-4-26b-a4b-it");
    expect(result.candidates[0]?.translation?.body.value).toContain('<a href="https://example.test/first">linked paragraph</a>');
    expect(result.candidates[0]?.translation?.body.value).toContain("<strong>emphasized paragraph</strong>");
  });

  it("regenerates a corrupt cache instead of failing the Process", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "jojo-gemma-corrupt-cache-"));
    const value = candidate("corrupt-cache");
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => translatedResponse(init));
    const options = {
      apiKey: "test-key",
      fetchImpl: fetchMock as unknown as typeof fetch,
      requestsPerMinute: 100,
      tokensPerMinute: 1_000_000,
    };
    const first = await translateProcessedCandidates(output, [value], options);
    const cacheObject = first.candidates[0]!.translationCacheObject!;
    await writeFile(path.join(output, ...cacheObject.split("/")), "not-gzip");

    fetchMock.mockClear();
    const regenerated = await translateProcessedCandidates(output, [value], options);
    expect(regenerated.stats).toMatchObject({ translated: 1, cacheHits: 0, failed: 0, requests: 1 });
    expect(fetchMock).toHaveBeenCalledOnce();
    const regeneratedCache = await readFile(path.join(output, ...cacheObject.split("/")));
    expect(() => gunzipSync(regeneratedCache)).not.toThrow();
  });

  it("skips Chinese and fails open when both hosted models are unavailable", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "jojo-gemma-fail-open-"));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: "high demand" } }), { status: 503 })) as typeof fetch;
    const english = candidate("english");
    const chinese = candidate("chinese", "zh-CN");
    const result = await translateProcessedCandidates(output, [english, chinese], {
      apiKey: "test-key",
      fetchImpl,
      requestsPerMinute: 100,
      tokensPerMinute: 1_000_000,
    });
    expect(result.stats).toMatchObject({ eligible: 1, translated: 0, failed: 1, notRequired: 1, requests: 2 });
    expect(result.candidates[0]).toMatchObject({ processedBody: english.processedBody, translationStatus: "failed" });
    expect(result.candidates[0]?.translation).toBeUndefined();
    expect(result.candidates[1]?.translationStatus).toBeUndefined();
  });

  it("fails open without claiming success when a full body has no semantic blocks", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "jojo-gemma-no-blocks-"));
    const value = { ...candidate("no-blocks"), processedBody: "<div>Unstructured article text</div>" };
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await translateProcessedCandidates(output, [value], {
      apiKey: "test-key",
      fetchImpl,
      requestsPerMinute: 100,
      tokensPerMinute: 1_000_000,
    });
    expect(result.stats).toMatchObject({ eligible: 1, translated: 0, failed: 1, requests: 0 });
    expect(result.candidates[0]?.translation).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("enforces a hard batch deadline so translation cannot hold the Process indefinitely", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "jojo-gemma-deadline-"));
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new DOMException("aborted", "AbortError"));
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    }));
    const started = Date.now();
    const result = await translateProcessedCandidates(output, [candidate("one"), candidate("two")], {
      apiKey: "test-key",
      workers: 1,
      requestTimeoutMs: 1_000,
      batchTimeoutMs: 30,
      requestsPerMinute: 100,
      tokensPerMinute: 1_000_000,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(result.stats).toMatchObject({ eligible: 2, translated: 0, failed: 2, requests: 1 });
    expect(Date.now() - started).toBeLessThan(500);
  });
});
