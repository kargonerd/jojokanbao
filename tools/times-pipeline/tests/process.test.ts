import { gzipSync } from "node:zlib";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractArticleBody } from "../src/content/body.js";
import { processArticle } from "../src/process/article.js";
import { extractBloombergBody } from "../src/sources/bloomberg/process.js";
import type { Candidate, SourceConfig } from "../src/types.js";

describe("article processing", () => {
  it("extracts only Reuters-owned paragraph and list blocks from rendered DOM", () => {
    const intro = `<div data-testid="paragraph-0">${"Reuters introduction. ".repeat(20)}</div>`;
    const details = Array.from({ length: 4 }, (_, index) =>
      `<div data-testid="unordered-0"><div data-testid="Body">${`Article detail ${index}. `.repeat(15)}</div></div>`
    ).join("");
    const unrelated = '<div data-testid="Body">Company widget that must not be included.</div>';
    const body = extractArticleBody(`<html><body>${intro}${details}${unrelated}</body></html>`, {
      capture: "browser",
      bodySelectors: [
        "[data-testid^='paragraph-'], [data-testid^='unordered-'] [data-testid='Body'], [data-testid='SignOff'] [data-testid='Body']",
      ],
    });

    expect(body?.match(/<p>/gu)).toHaveLength(5);
    expect(body).not.toContain("Company widget");
  });

  it("uses the source's quality threshold for short complete news articles", () => {
    const body = extractArticleBody("<article><p>这是一篇完整但很短的快讯正文，来源会明确允许单段短稿进入全文。</p></article>", undefined, {
      minimumCharacters: 20,
      minimumParagraphs: 1,
    });

    expect(body).toContain("完整但很短的快讯正文");
  });

  it("uses the complete source-owned container when an article mixes paragraphs and text nodes", () => {
    const body = extractArticleBody(
      `<div id="publisher-body">${"正文直接文本。".repeat(30)}<p>来源信息不会让直接文本丢失。</p></div>`,
      { capture: "browser", bodySelectors: ["#publisher-body"] },
      { minimumCharacters: 100, minimumParagraphs: 1 },
    );

    expect(body).toContain("正文直接文本");
  });

  it("delegates Bloomberg's embedded body format to its publisher process module", () => {
    const nextData = {
      props: { pageProps: { story: { body: { content: [
        { type: "text", value: "First Bloomberg paragraph contains enough text for extraction." },
        { type: "ad", content: [{ type: "text", value: "Advertisement must be ignored completely." }] },
        { type: "text", value: "Second Bloomberg paragraph also belongs to the article body." },
      ] } } } },
    };
    const body = extractArticleBody(
      `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script>`,
      { capture: "browser", bodySelectors: [] },
      { minimumCharacters: 50, minimumParagraphs: 2 },
      extractBloombergBody,
    );

    expect(body).toContain("First Bloomberg paragraph");
    expect(body).toContain("Second Bloomberg paragraph");
    expect(body).not.toContain("Advertisement");
  });

  it("builds processed content from the persisted Raw rendered page without mutating Raw", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "jojo-times-process-"));
    const pageRoot = path.join(output, "raw", "example", "runs", "run-1", "pages", "page-1");
    await mkdir(pageRoot, { recursive: true });
    await writeFile(path.join(pageRoot, "rendered.html.gz"), gzipSync(
      `<article><p>${"Persisted article body. ".repeat(10)}</p></article>`,
    ));
    await writeFile(path.join(pageRoot, "metadata.json"), JSON.stringify({
      formatVersion: "jojo-raw-page/1",
      renderedHtml: "rendered.html.gz",
    }));
    const source: SourceConfig = {
      id: "example",
      name: "Example",
      language: "en",
      publicationTimeZone: "UTC",
      discovery: { kind: "official-rss", url: "https://example.test/feed" },
      content: { priority: ["captured-page"], minimumFullCharacters: 50, minimumFullParagraphs: 1 },
      fetch: { strategy: "direct-first", bpc: false },
      health: { minimumCandidates: 1 },
      enabled: true,
    };
    const candidate: Candidate = {
      articleId: "example:one",
      sourceId: "example",
      sourceName: "Example",
      language: "en",
      sourceUrl: "https://example.test/one",
      canonicalUrl: "https://example.test/one",
      title: "One",
      contentStatus: "summary",
      publishedAt: "2026-08-27T00:00:00Z",
      authors: [],
      publisherCategories: [],
      rawPageObject: "raw/example/runs/run-1/pages/page-1/metadata.json",
      assets: [{
        id: "asset:image",
        type: "image",
        role: "lead",
        sourceUrl: "https://example.test/lead.jpg",
        rawObject: "raw/example/assets/image.jpg",
        mediaType: "image/jpeg",
        size: 10,
        sha256: "image",
      }],
    };

    const processed = await processArticle(output, source, candidate, { capture: "http", bodySelectors: ["article"] });

    expect(processed.processedBody).toMatch(/^<figure data-asset-id="asset:image"><\/figure><p>/u);
    expect(processed.processedBody).toContain("Persisted article body");
    expect(processed.contentStatus).toBe("full");
    expect(candidate).not.toHaveProperty("processedBody");
    expect(candidate.contentStatus).toBe("summary");
  });
});
