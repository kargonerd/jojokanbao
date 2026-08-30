import { gzipSync } from "node:zlib";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProcessedCandidate } from "../src/process/article.js";
import { restoreTranslationContext } from "../src/process/translation-retry.js";

function candidate(): ProcessedCandidate {
  return {
    articleId: "ap:stale",
    sourceId: "ap",
    sourceName: "AP",
    language: "en",
    sourceUrl: "https://apnews.com/article/stale",
    canonicalUrl: "https://apnews.com/article/stale",
    title: "Live article",
    captureStatus: "unchanged",
    contentStatus: "full",
    publishedAt: "2026-08-30T05:00:00Z",
    authors: [],
    publisherCategories: [],
    assets: [],
  };
}

describe("translation retry context", () => {
  it("hydrates stale translations for retry but skips fresh ones", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "jojo-translation-context-"));
    const articleObject = "canonical/ap/articles/stale.json.gz";
    const indexFile = path.join(output, "canonical", "ap", "dates", "2026", "08", "2026-08-30.json.gz");
    const articleFile = path.join(output, ...articleObject.split("/"));
    await mkdir(path.dirname(indexFile), { recursive: true });
    await mkdir(path.dirname(articleFile), { recursive: true });
    await writeFile(indexFile, gzipSync(JSON.stringify({
      articles: [{ articleId: "ap:stale", object: articleObject }],
    })));
    const translation = {
      language: "zh-CN" as const,
      title: "实时文章",
      body: { format: "html" as const, profile: "jojo-semantic-html/1" as const, value: "<p>旧译文</p>" },
      provider: "google-gemini-api" as const,
      model: "gemma-4-31b-it",
      translatedAt: "2026-08-30T05:01:00Z",
      sourceHash: "old-source",
      stale: true,
    };
    await writeFile(articleFile, gzipSync(JSON.stringify({
      articleId: "ap:stale",
      body: { value: '<p>Updated <a href="https://example.test">source article</a>.</p>' },
      translations: { "zh-CN": translation },
      assets: [],
    })));

    const [stale] = await restoreTranslationContext(output, [candidate()]);
    expect(stale).toMatchObject({
      processedBody: '<p>Updated <a href="https://example.test">source article</a>.</p>',
      previousTranslations: { "zh-CN": { title: "实时文章", stale: true } },
    });

    await writeFile(articleFile, gzipSync(JSON.stringify({
      articleId: "ap:stale",
      body: { value: "<p>Current source article.</p>" },
      translations: { "zh-CN": { ...translation, stale: undefined } },
      assets: [],
    })));
    const [fresh] = await restoreTranslationContext(output, [candidate()]);
    expect(fresh?.processedBody).toBeUndefined();

    const [outdatedPolicy] = await restoreTranslationContext(output, [candidate()], "zh-CN", "gemma-news-zh-v2");
    expect(outdatedPolicy?.processedBody).toBe("<p>Current source article.</p>");

    await writeFile(articleFile, gzipSync(JSON.stringify({
      articleId: "ap:stale",
      body: { value: "<p>Current source article.</p>" },
      translations: { "zh-CN": { ...translation, policy: "gemma-news-zh-v2", stale: undefined } },
      assets: [],
    })));
    const [currentPolicy] = await restoreTranslationContext(output, [candidate()], "zh-CN", "gemma-news-zh-v2");
    expect(currentPolicy?.processedBody).toBeUndefined();

    const changed = { ...candidate(), captureStatus: "captured" as const, processedBody: "<p>New source body.</p>" };
    const [withPrevious] = await restoreTranslationContext(output, [changed]);
    expect(withPrevious?.previousTranslations?.["zh-CN"]?.title).toBe("实时文章");
  });
});
