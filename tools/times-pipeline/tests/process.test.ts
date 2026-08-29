import { gzipSync } from "node:zlib";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractArticleBody } from "../src/content/body.js";
import { processArticle } from "../src/process/article.js";
import { extractApBody } from "../src/sources/ap/process.js";
import { extractBloombergBody } from "../src/sources/bloomberg/process.js";
import { extractClsBody } from "../src/sources/cls/process.js";
import { extractThepaperBody } from "../src/sources/thepaper/process.js";
import type { Candidate, SourceConfig } from "../src/types.js";

describe("article processing", () => {
  it("extracts only Reuters-owned paragraph and list blocks from rendered DOM", () => {
    const intro = `<div data-testid="paragraph-0">${"Reuters introduction. ".repeat(20)}</div>`;
    const details = Array.from({ length: 4 }, (_, index) =>
      `<div data-testid="unordered-0"><div data-testid="Body">${`Article detail ${index}. `.repeat(15)}</div></div>`
    ).join("");
    const unrelated = '<div data-testid="Body">Company widget that must not be included.</div>';
    const body = extractArticleBody(`<html><body><article>${intro}${details}${unrelated}</article></body></html>`, {
      capture: "browser",
      bodySelectors: [
        "[data-testid^='paragraph-'], [data-testid^='unordered-'] [data-testid='Body'], [data-testid='SignOff'] [data-testid='Body']",
      ],
    });

    expect(body?.match(/<p>/gu)).toHaveLength(5);
    expect(body).not.toContain("Company widget");
  });

  it("accepts a complete one-paragraph Reuters brief above the publisher threshold", () => {
    const paragraph = "Aug 28 (Reuters) - Iran's Revolutionary Guards Corps Navy rejected U.S. claims that the Strait of Hormuz was open, calling them an attempt to control oil prices and conceal what it described as U.S. failures. It said the restrictions would continue until U.S. military actions against Iran end and relevant commitments are implemented, according to a statement.";
    const body = extractArticleBody(
      `<div data-testid="paragraph-0">${paragraph}</div>`,
      {
        capture: "browser",
        bodySelectors: [
          "[data-testid^='paragraph-'], [data-testid^='unordered-'] [data-testid='Body'], [data-testid='SignOff'] [data-testid='Body']",
        ],
      },
      { minimumCharacters: 300, minimumParagraphs: 1 },
    );

    expect(body).toContain("Strait of Hormuz");
    expect(body?.match(/<p>/gu)).toHaveLength(1);
  });

  it("uses the source's quality threshold for short complete news articles", () => {
    const body = extractArticleBody("<article><p>这是一篇完整但很短的快讯正文，来源会明确允许单段短稿进入全文。</p></article>", undefined, {
      minimumCharacters: 20,
      minimumParagraphs: 1,
    });

    expect(body).toContain("完整但很短的快讯正文");
  });

  it("accepts Africanews video stories that also contain a substantial single-paragraph report", () => {
    const report = "Around a dozen activists gathered outside the representative offices and called for a stronger response. ".repeat(8);
    const body = extractArticleBody(
      `<main><article class="teaser teaser--wide clearfix"><h1>Video report</h1><p>${report}</p></article></main>
       <aside><article><p>Unrelated recommendation must not enter the article body.</p></article></aside>`,
      { capture: "browser", bodySelectors: [".article-content", ".article__body", "article"] },
      { minimumCharacters: 500, minimumParagraphs: 1 },
    );

    expect(body).toContain("Around a dozen activists");
    expect(body?.match(/<p>/gu)).toHaveLength(1);
    expect(body).not.toContain("Unrelated recommendation");
  });

  it("uses the complete source-owned container when an article mixes paragraphs and text nodes", () => {
    const body = extractArticleBody(
      `<div id="publisher-body">${"正文直接文本。".repeat(30)}<p>来源信息不会让直接文本丢失。</p></div>`,
      { capture: "browser", bodySelectors: ["#publisher-body"] },
      { minimumCharacters: 100, minimumParagraphs: 1 },
    );

    expect(body).toContain("正文直接文本");
  });

  it("removes access-check boilerplate without rejecting the publisher's full article", () => {
    const body = extractArticleBody(
      `<section name="articleBody">
        <p>${"First reported paragraph. ".repeat(12)}</p>
        <p>${"Second reported paragraph. ".repeat(12)}</p>
        <p>Thank you for your patience while we verify access. Already a subscriber? Log in.</p>
      </section>`,
      { capture: "browser", bodySelectors: ["section[name='articleBody']"] },
      { minimumCharacters: 200, minimumParagraphs: 2 },
    );

    expect(body).toContain("First reported paragraph");
    expect(body).not.toContain("verify access");
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

  it("extracts all AP live-blog updates from publisher JSON-LD", () => {
    const liveBlog = [{
      "@context": "https://schema.org",
      "@type": "LiveBlogPosting",
      headline: "Trial live updates",
      liveBlogUpdate: [
        {
          "@type": "BlogPosting",
          headline: "Jury asks to see evidence",
          articleBody: "The jury asked to review evidence from the trial.<br/><br/>The judge consulted both legal teams before responding.",
        },
        {
          "@type": "BlogPosting",
          headline: "Court returns to session",
          articleBody: "The court returned to session on Friday morning.<br/><br/>Jurors then resumed their deliberations.",
        },
      ],
    }];
    const body = extractArticleBody(
      `<script type="application/ld+json">${JSON.stringify(liveBlog)}</script>`,
      { capture: "browser", bodySelectors: [".RichTextStoryBody"] },
      { minimumCharacters: 150, minimumParagraphs: 4 },
      extractApBody,
    );

    expect(body).toContain("Jury asks to see evidence");
    expect(body).toContain("Jurors then resumed their deliberations");
    expect(body?.match(/<p>/gu)).toHaveLength(6);
  });

  it("accepts a complete three-paragraph AP bulletin below the global length threshold", () => {
    const paragraphs = [
      "The administration announced an agreement on Friday and described the arrangement as an immediate change in policy. Officials said implementation would begin after agencies complete the required operational review.",
      "The announcement followed several days of negotiations between senior officials. The parties said the agreement covers the principal terms, while technical details will be published separately.",
      "Lawmakers from both parties requested additional information about oversight and timing. The administration said it would brief Congress and answer questions as the arrangement moves forward.",
    ];
    const body = extractArticleBody(
      `<div class="RichTextStoryBody">${paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join("")}</div>`,
      { capture: "browser", bodySelectors: [".RichTextStoryBody", "[itemprop='articleBody']"] },
      { minimumCharacters: 400, minimumParagraphs: 3 },
      extractApBody,
    );

    expect(paragraphs.join(" ").length).toBeGreaterThanOrEqual(400);
    expect(paragraphs.join(" ").length).toBeLessThan(800);
    expect(body?.match(/<p>/gu)).toHaveLength(3);
    expect(body).toContain("Lawmakers from both parties");
  });

  it("extracts The Paper content from Next.js data and persisted discovery fragments", () => {
    const content = [
      "邮储银行中期业绩正文第一段，包含足够的信息用于验证澎湃新闻的专用正文解析。",
      "邮储银行中期业绩正文第二段，浏览器页面不需要存在传统的 article 正文容器。",
    ];
    const nextData = {
      props: { pageProps: { detailData: { contentDetail: {
        content: content.map((paragraph) => `<p>${paragraph}</p>`).join(""),
      } } } },
    };
    const quality = { minimumCharacters: 50, minimumParagraphs: 2 };
    const pageBody = extractArticleBody(
      `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></body></html>`,
      { capture: "browser", bodySelectors: [".index_cententWrap", ".news_txt", "article"] },
      quality,
      extractThepaperBody,
    );
    const discoveryBody = extractArticleBody(
      content.map((paragraph) => `<p>${paragraph}</p>`).join(""),
      { capture: "browser", bodySelectors: [".index_cententWrap", ".news_txt", "article"] },
      quality,
      extractThepaperBody,
    );

    expect(pageBody).toContain(content[0]);
    expect(pageBody?.match(/<p>/gu)).toHaveLength(2);
    expect(discoveryBody).toBe(pageBody);
  });

  it("accepts a The Paper image-only report as publisher-owned content", () => {
    const nextData = {
      props: { pageProps: { detailData: { contentDetail: {
        content: '<img class="img_default" data-src="https://imgpai.thepaper.cn/report.webp" width="1022" height="3183">',
      } } } },
    };
    const body = extractArticleBody(
      `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></body></html>`,
      { capture: "browser", bodySelectors: ["[class*='cententWrap__']", "article"] },
      { minimumCharacters: 300, minimumParagraphs: 2 },
      extractThepaperBody,
    );

    expect(body).toContain("data-publisher-image-only");
  });

  it("extracts CLS plain-text content from Next.js data without a DOM body container", () => {
    const content = "财联社8月28日电，公司发布半年度报告，营业收入同比增长，归属于上市公司股东的净利润实现扭亏为盈。".repeat(3);
    const nextData = {
      props: { pageProps: { articleDetail: { id: 2_467_941, content } } },
    };
    const body = extractArticleBody(
      `<html><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></body></html>`,
      { capture: "browser", bodySelectors: [".detail-content", ".article-content", "article"] },
      { minimumCharacters: 100, minimumParagraphs: 1 },
      extractClsBody,
    );

    expect(body).toContain("财联社8月28日电");
    expect(body?.match(/<p>/gu)).toHaveLength(1);
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
