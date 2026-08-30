import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { load } from "cheerio";
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
  const request = JSON.parse(String(init?.body)) as {
    contents: Array<{ parts: Array<{ text: string }> }>;
    generationConfig?: Record<string, unknown>;
  };
  const prompt = request.contents[0]!.parts[0]!.text;
  const html = prompt.slice(prompt.indexOf("HTML:\n") + 6);
  const document = load(html, undefined, false);
  type InlineNode = { type: string; data?: string; children?: InlineNode[] };
  const translate = (node: InlineNode): void => {
    if (node.type === "text" && (node.data ?? "").trim()) node.data = `中译：${node.data ?? ""}`;
    for (const child of node.children ?? []) translate(child);
  };
  for (const node of document.root().contents().toArray()) translate(node as InlineNode);
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: document.html() }] }, finishReason: "STOP" }],
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

  it("extracts and applies complete HTML blocks while retaining article structure", () => {
    const body = '<blockquote><p>Quoted <strong>text</strong></p></blockquote><figure data-asset-id="lead"><figcaption>Caption</figcaption></figure>';
    expect(extractArticleTranslationBlocks(body)).toEqual([
      { tag: "p", html: "<p>Quoted <strong>text</strong></p>" },
      { tag: "figcaption", html: "<figcaption>Caption</figcaption>" },
    ]);
    expect(applyArticleTranslation(body, [
      { tag: "p", html: "<p>译文<strong>&lt;不会成为标签&gt;</strong></p>" },
      { tag: "figcaption", html: "<figcaption>图片说明</figcaption>" },
    ])).toBe('<blockquote><p>译文<strong>&lt;不会成为标签&gt;</strong></p></blockquote><figure data-asset-id="lead"><figcaption>图片说明</figcaption></figure>');
  });

  it("rejects changed protected HTML instead of silently dropping article links", () => {
    const body = '<p>Read <a href="https://example.test/story">the full story</a>.</p>';
    expect(() => applyArticleTranslation(body, [{ tag: "p", html: "<p>阅读全文。</p>" }]))
      .toThrow("changed protected HTML");
    expect(applyArticleTranslation(body, [{
      tag: "p",
      html: '<p>阅读<a href="https://example.test/story">完整报道</a>。</p>',
    }])).toBe('<p>阅读<a href="https://example.test/story">完整报道</a>。</p>');
  });

  it("accepts visually equivalent consolidation of plain emphasis around a preserved link", () => {
    const body = '<p><em>Before </em><a href="https://example.test/story">clicking here</a><em> for more.</em></p>';
    expect(applyArticleTranslation(body, [{
      tag: "p",
      html: '<p><em>更多信息请<a href="https://example.test/story">点击这里</a>查看。</em></p>',
    }])).toBe('<p><em>更多信息请<a href="https://example.test/story">点击这里</a>查看。</em></p>');
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
    expect(first.candidates[0]?.translation?.body.value).toContain('<a href="https://example.test">中译：paragraph</a>');
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

  it("round-robins concurrent translations across independently limited API projects", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "jojo-gemma-key-pool-"));
    const requestedKeys: string[] = [];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestedKeys.push(new Headers(init?.headers).get("x-goog-api-key") ?? "");
      await new Promise((resolve) => setTimeout(resolve, 5));
      return translatedResponse(init);
    }) as typeof fetch;
    const result = await translateProcessedCandidates(
      output,
      Array.from({ length: 6 }, (_value, index) => candidate(`pool-${index + 1}`)),
      {
        apiKeys: ["project-a", "project-b", "project-c"],
        workers: 6,
        fetchImpl,
        requestsPerMinute: 100,
        tokensPerMinute: 1_000_000,
      },
    );

    expect(result.stats).toMatchObject({
      translated: 6,
      failed: 0,
      requests: 6,
      configuredProjects: 3,
      quotaKeySwitches: 0,
    });
    expect(requestedKeys).toEqual([
      "project-a", "project-b", "project-c", "project-a", "project-b", "project-c",
    ]);
  });

  it("retries a project-scoped 429 on the next configured API project", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "jojo-gemma-key-rotation-"));
    const requestedKeys: string[] = [];
    const progress: string[] = [];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const key = new Headers(init?.headers).get("x-goog-api-key") ?? "";
      requestedKeys.push(key);
      return key === "project-a"
        ? new Response(JSON.stringify({ error: { message: "project quota exhausted" } }), { status: 429 })
        : translatedResponse(init);
    }) as typeof fetch;
    const result = await translateProcessedCandidates(output, [candidate("quota-rotation")], {
      apiKeys: ["project-a", "project-b"],
      fetchImpl,
      requestsPerMinute: 100,
      tokensPerMinute: 1_000_000,
      onProgress: (message) => progress.push(message),
    });

    expect(result.stats).toMatchObject({
      translated: 1,
      failed: 0,
      requests: 2,
      configuredProjects: 2,
      quotaKeySwitches: 1,
    });
    expect(result.candidates[0]?.translation?.model).toBe("gemma-4-31b-it");
    expect(requestedKeys).toEqual(["project-a", "project-b"]);
    expect(progress).toContain("[translation] gemma-4-31b-it project 1/2 returned 429; retrying project 2/2");
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

  it("falls back per chunk when the primary model changes protected HTML", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "jojo-gemma-marker-fallback-"));
    const primaryResponse = (init: RequestInit | undefined): Response => {
      const request = JSON.parse(String(init?.body)) as {
        contents: Array<{ parts: Array<{ text: string }> }>;
        generationConfig?: Record<string, unknown>;
      };
      const prompt = request.contents[0]!.parts[0]!.text;
      const document = load(prompt.slice(prompt.indexOf("HTML:\n") + 6), undefined, false);
      expect(prompt).not.toContain("JOJO_INLINE");
      expect(prompt).not.toContain("data-jojo-id");
      expect(prompt).not.toContain('"segments"');
      expect(request.generationConfig?.responseMimeType).toBeUndefined();
      document("a,strong").each((_index, element) => {
        document(element).replaceWith(document(element).text());
      });
      return new Response(JSON.stringify({
        candidates: [{
          content: { parts: [{ text: document.html() }] },
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
    expect(result.candidates[0]?.translation?.body.value).toContain('<a href="https://example.test/first">中译：linked paragraph</a>');
    expect(result.candidates[0]?.translation?.body.value).toContain("<strong>中译：emphasized paragraph</strong>");
  });

  it("backs off repeated failures and retries after the persisted delay", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "jojo-gemma-backoff-"));
    let available = false;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => (
      available
        ? translatedResponse(init)
        : new Response(JSON.stringify({ error: { message: "high demand" } }), { status: 503 })
    ));
    const first = await translateProcessedCandidates(output, [candidate("backoff")], {
      apiKey: "test-key",
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => new Date("2026-08-30T01:00:00Z"),
      requestsPerMinute: 100,
      tokensPerMinute: 1_000_000,
    });
    expect(first.stats).toMatchObject({ failed: 1, deferred: 0, requests: 2 });

    fetchMock.mockClear();
    const deferred = await translateProcessedCandidates(output, [candidate("backoff")], {
      apiKey: "test-key",
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => new Date("2026-08-30T01:10:00Z"),
      requestsPerMinute: 100,
      tokensPerMinute: 1_000_000,
    });
    expect(deferred.stats).toMatchObject({ failed: 0, deferred: 1, requests: 0 });
    expect(deferred.candidates[0]?.translationStatus).toBe("deferred");
    expect(fetchMock).not.toHaveBeenCalled();

    available = true;
    const retried = await translateProcessedCandidates(output, [candidate("backoff")], {
      apiKey: "test-key",
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => new Date("2026-08-30T01:31:00Z"),
      requestsPerMinute: 100,
      tokensPerMinute: 1_000_000,
    });
    expect(retried.stats).toMatchObject({ translated: 1, deferred: 0, failed: 0, requests: 1 });
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
