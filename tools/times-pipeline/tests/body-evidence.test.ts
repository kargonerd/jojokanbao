import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assessArticleBody,
  extractArticleBody,
  selectArticleBody,
  type ArticleBodyExtractor,
} from "../src/content/body.js";
import { writeRawPage } from "../src/capture/raw-page.js";
import { processArticle } from "../src/process/article.js";
import type { Candidate, SourceConfig, SourceFetchPolicy } from "../src/types.js";

const strictQuality = { minimumCharacters: 800, minimumParagraphs: 3 };
const policy: SourceFetchPolicy = { capture: "http", bodySelectors: ["article"] };
const pageUrl = "https://example.test/brief";
const brief = "Taipei officials said the market opened lower on Monday after overseas shares declined during the previous session.";
const briefHtml = `<article><p>${brief}</p></article>`;

const publisherComplete: ArticleBodyExtractor = (html) => ({
  html,
  completeness: "publisher-complete",
  evidence: { kind: "terminal-marker", marker: "Enditem" },
});

describe("publisher body completeness evidence", () => {
  it("accepts identical short HTML only when the publisher supplies completeness evidence", () => {
    const generic = assessArticleBody(
      briefHtml,
      policy,
      strictQuality,
      undefined,
      pageUrl,
      "captured-page",
    );
    const verified = assessArticleBody(
      briefHtml,
      policy,
      strictQuality,
      publisherComplete,
      pageUrl,
      "captured-page",
    );
    const unknownStructured = assessArticleBody(
      briefHtml,
      policy,
      strictQuality,
      (html) => ({ html, completeness: "unknown" }),
      pageUrl,
      "captured-page",
    );

    expect(generic).toMatchObject({
      completeness: "unknown",
      characters: brief.length,
      contentBlocks: 1,
      verdict: "rejected",
      rejectReason: "below-quality-threshold",
    });
    expect(generic.body).toBeUndefined();
    expect(unknownStructured.verdict).toBe("rejected");
    expect(verified).toMatchObject({
      extractionPath: "publisher-extractor",
      completeness: "publisher-complete",
      characters: brief.length,
      contentBlocks: 1,
      minimumCharacters: 20,
      minimumContentBlocks: 1,
      verdict: "accepted",
      evidence: { kind: "terminal-marker", marker: "Enditem" },
    });
    expect(verified.body).toBe(`<p>${brief}</p>`);
  });

  it("keeps selector and JSON-LD fallbacks unknown and behind source quality", () => {
    const selector = assessArticleBody(
      briefHtml,
      policy,
      strictQuality,
      undefined,
      pageUrl,
      "captured-page",
    );
    const jsonLd = assessArticleBody(
      `<script type="application/ld+json">${JSON.stringify({ articleBody: brief })}</script>`,
      undefined,
      strictQuality,
      undefined,
      pageUrl,
      "discovery-body",
    );

    expect(selector).toMatchObject({ extractionPath: "source-selector", completeness: "unknown", verdict: "rejected" });
    expect(jsonLd).toMatchObject({ extractionPath: "json-ld", completeness: "unknown", verdict: "rejected" });
  });

  it("rejects publisher-complete content below the sanitation floor", () => {
    const assessed = assessArticleBody(
      "<article><p>Too short.</p></article>",
      policy,
      strictQuality,
      publisherComplete,
      pageUrl,
      "captured-page",
    );

    expect(assessed).toMatchObject({
      completeness: "publisher-complete",
      verdict: "rejected",
      rejectReason: "below-sanitation-floor",
      minimumCharacters: 20,
      minimumContentBlocks: 1,
    });
  });

  it("treats publisher truncation as terminal even when generic DOM looks long enough", () => {
    const longHtml = `<article>${Array.from({ length: 4 }, (_, index) => (
      `<p>${`Generic paragraph ${index} contains enough repeated text to clear the normal article threshold. `.repeat(4)}</p>`
    )).join("")}</article>`;
    const assessed = assessArticleBody(
      longHtml,
      policy,
      { minimumCharacters: 200, minimumParagraphs: 3 },
      (html) => ({
        html,
        completeness: "truncated",
        evidence: { kind: "continuation-marker", marker: "Read more" },
      }),
      pageUrl,
      "captured-page",
    );

    expect(assessed).toMatchObject({
      extractionPath: "publisher-extractor",
      completeness: "truncated",
      verdict: "rejected",
      rejectReason: "publisher-truncated",
    });
    expect(assessed.body).toBeUndefined();
  });

  it("does not replace captured-page truncation with an otherwise acceptable discovery body", () => {
    const discoveryHtml = `<article>${Array.from({ length: 3 }, (_, index) => (
      `<p>${`Complete discovery paragraph ${index} contains enough reported detail for the configured quality gate. `.repeat(3)}</p>`
    )).join("")}</article>`;
    const extractor: ArticleBodyExtractor = (html) => html.includes("data-publisher-truncated")
      ? {
          html,
          completeness: "truncated",
          evidence: { kind: "continuation-marker", marker: "Continue reading" },
        }
      : undefined;
    const discoveryOnly = selectArticleBody({
      discoveryBody: { html: discoveryHtml, pageUrl },
    }, policy, { minimumCharacters: 200, minimumParagraphs: 3 }, extractor);
    const selected = selectArticleBody({
      capturedPage: {
        html: `<article data-publisher-truncated><p>${"Captured excerpt is explicitly incomplete. ".repeat(8)}</p></article>`,
        pageUrl,
      },
      discoveryBody: { html: discoveryHtml, pageUrl },
    }, policy, { minimumCharacters: 200, minimumParagraphs: 3 }, extractor);

    expect(discoveryOnly.body).toBeDefined();
    expect(selected.body).toBeUndefined();
    expect(selected.report).toEqual({
      attempts: [expect.objectContaining({
        origin: "captured-page",
        completeness: "truncated",
        verdict: "rejected",
        rejectReason: "publisher-truncated",
      })],
    });
  });

  it("leaves established long generic extraction output unchanged", () => {
    const paragraphs = Array.from({ length: 3 }, (_, index) => (
      `Reported paragraph ${index + 1} contains sufficient verified context for the complete article and its readers.`
    ));
    const html = `<article>${paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join("")}</article>`;
    const body = extractArticleBody(
      html,
      policy,
      { minimumCharacters: 200, minimumParagraphs: 3 },
      undefined,
      pageUrl,
    );

    expect(body).toBe(paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join(""));
  });

  it("uses one selection decision in capture diagnostics and processing", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "jojo-body-evidence-"));
    const html = `<article data-terminal="Enditem"><p>${brief}</p></article>`;
    const extractor: ArticleBodyExtractor = (value) => value.includes('data-terminal="Enditem"')
      ? {
          html: value,
          completeness: "publisher-complete",
          evidence: { kind: "terminal-marker", marker: "Enditem", location: "article[data-terminal]" },
        }
      : undefined;
    const captureSelection = selectArticleBody({
      capturedPage: { html, pageUrl },
    }, policy, strictQuality, extractor);
    const manifestPath = path.join(output, "raw", "example", "runs", "run-1", "manifest.json");
    const rawPageObject = await writeRawPage(output, {
      articleId: "example:brief",
      sourceId: "example",
      manifestPath,
    }, {
      method: "direct",
      requestedUrl: pageUrl,
      finalUrl: pageUrl,
      status: 200,
      renderedHtml: html,
      capturedAt: "2026-08-31T00:00:00.000Z",
    }, undefined, captureSelection.report);
    const source: SourceConfig = {
      id: "example",
      name: "Example",
      language: "en",
      publicationTimeZone: "UTC",
      discovery: { kind: "official-rss", url: "https://example.test/feed" },
      content: {
        priority: ["captured-page"],
        minimumFullCharacters: strictQuality.minimumCharacters,
        minimumFullParagraphs: strictQuality.minimumParagraphs,
      },
      fetch: { strategy: "direct-first", bpc: false },
      health: { minimumCandidates: 1 },
      enabled: true,
    };
    const candidate: Candidate = {
      articleId: "example:brief",
      sourceId: source.id,
      sourceName: source.name,
      language: source.language,
      sourceUrl: pageUrl,
      canonicalUrl: pageUrl,
      title: "Short verified bulletin",
      rawPageObject,
      captureStatus: "captured",
      contentStatus: "full",
      publishedAt: "2026-08-31T00:00:00.000Z",
      authors: [],
      publisherCategories: [],
    };

    const processed = await processArticle(output, source, candidate, policy, extractor);
    const metadata = JSON.parse(await readFile(path.join(output, ...rawPageObject.split("/")), "utf8")) as {
      bodyAssessment?: unknown;
    };

    expect(captureSelection.report).toMatchObject({
      selectedOrigin: "captured-page",
      attempts: [{ verdict: "accepted", completeness: "publisher-complete" }],
    });
    expect(processed.bodyAssessment).toEqual(captureSelection.report);
    expect(processed.processedBody).toBe(`<p>${brief}</p>`);
    expect(metadata.bodyAssessment).toEqual(captureSelection.report);
    expect(JSON.stringify(metadata.bodyAssessment)).not.toContain(brief);
  });
});
