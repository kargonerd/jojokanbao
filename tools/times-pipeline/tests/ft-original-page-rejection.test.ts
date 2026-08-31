import { gzipSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeRawPage } from "../src/capture/raw-page.js";
import { bodyQuality, selectArticleBody } from "../src/content/body.js";
import { processArticle } from "../src/process/article.js";
import {
  sourceBodyExtractor,
  sourceFetchPolicy,
  sourceOriginalPageRejectionClassifier,
} from "../src/sources/registry.js";
import type { Candidate, SourceConfig } from "../src/types.js";

const PAGE_URL = "https://www.ft.com/content/original-offer";
const RENDERED_WITHOUT_ARTICLE = "<!doctype html><html><body><main><div data-ft-shell></div></main></body></html>";
const CONSUMER_OFFER_BLOCKS = `
  <p>Complete digital access to quality FT journalism on any device.</p>
  <p>Explore our full range of subscriptions.</p>
  <p>Discover all the plans currently available in your country.</p>
  <p>Digital access for organisations. Includes exclusive features and content.</p>`;
const CONSUMER_OFFER_ORIGINAL = `<!doctype html><html><body><div data-access-offer>${CONSUMER_OFFER_BLOCKS}</div></body></html>`;
const ARTICLE_PARAGRAPHS = Array.from({ length: 4 }, (_, index) => (
  `<p>${`Verified FT article paragraph ${index + 1} contains reported detail, context and analysis for readers. `.repeat(5)}</p>`
)).join("");
const VALID_RENDERED = `<html><body><article><div class="article__content-body">${ARTICLE_PARAGRAPHS}</div></article></body></html>`;

async function ftSource(): Promise<SourceConfig> {
  return JSON.parse(await readFile(path.resolve("src/sources/ft/source.json"), "utf8")) as SourceConfig;
}

function candidate(source: SourceConfig, rawPageObject: string, captureStatus: Candidate["captureStatus"] = "failed"): Candidate {
  return {
    articleId: "ft:original-offer",
    sourceId: source.id,
    sourceName: source.name,
    language: source.language,
    sourceUrl: PAGE_URL,
    canonicalUrl: PAGE_URL,
    title: "FT original response offer",
    summary: "Discovery summary",
    contentStatus: "summary",
    captureStatus,
    rawPageObject,
    publishedAt: "2026-08-31T12:00:00.000Z",
    authors: [],
    publisherCategories: [],
  };
}

describe("FT original-page rejection evidence", () => {
  it("persists and replays an original-only 4/4 access offer as terminal evidence", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "jojo-ft-original-offer-"));
    const source = await ftSource();
    const fetchPolicy = sourceFetchPolicy(source.id);
    const extractor = sourceBodyExtractor(source.id);
    const classifier = sourceOriginalPageRejectionClassifier(source.id);
    expect(classifier).toBeTypeOf("function");

    const selection = selectArticleBody({
      capturedPage: { html: RENDERED_WITHOUT_ARTICLE, pageUrl: PAGE_URL },
      originalPage: { html: CONSUMER_OFFER_ORIGINAL, pageUrl: PAGE_URL },
      discoveryBody: { html: VALID_RENDERED, pageUrl: PAGE_URL },
    }, fetchPolicy, bodyQuality(source), extractor, classifier);

    expect(selection.body).toBeUndefined();
    expect(selection.report).toEqual({
      attempts: [
        expect.objectContaining({ origin: "captured-page", verdict: "rejected" }),
        expect.objectContaining({
          origin: "original-page",
          extractionPath: "publisher-extractor",
          completeness: "truncated",
          verdict: "rejected",
          rejectReason: "publisher-truncated",
          evidence: {
            kind: "access-offer",
            marker: "consumer-subscription-offer",
            location: "original-page",
            matchedSignals: 4,
          },
        }),
      ],
    });

    const rawPageObject = await writeRawPage(output, {
      articleId: "ft:original-offer",
      sourceId: source.id,
      manifestPath: path.join(output, "raw", "ft", "runs", "run-original", "manifest.json"),
    }, {
      method: "browser",
      requestedUrl: PAGE_URL,
      finalUrl: PAGE_URL,
      status: 200,
      originalHtml: CONSUMER_OFFER_ORIGINAL,
      renderedHtml: RENDERED_WITHOUT_ARTICLE,
      capturedAt: "2026-08-31T12:01:00.000Z",
    }, "FullTextNotExtracted", selection.report);
    const processed = await processArticle(
      output,
      source,
      candidate(source, rawPageObject),
      fetchPolicy,
      extractor,
      classifier,
    );
    const metadata = JSON.parse(await readFile(path.join(output, ...rawPageObject.split("/")), "utf8")) as {
      bodyAssessment?: unknown;
    };

    expect(processed.processedBody).toBeUndefined();
    expect(processed.contentStatus).toBe("summary");
    expect(processed.bodyAssessment).toEqual(selection.report);
    expect(metadata.bodyAssessment).toEqual(selection.report);
  });

  it("keeps an accepted rendered FT body without invoking the original-page classifier", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "jojo-ft-rendered-body-"));
    const source = await ftSource();
    const extractor = sourceBodyExtractor(source.id);
    const actualClassifier = sourceOriginalPageRejectionClassifier(source.id);
    const classifier = vi.fn(actualClassifier);

    const selection = selectArticleBody({
      capturedPage: { html: VALID_RENDERED, pageUrl: PAGE_URL },
      originalPage: { html: CONSUMER_OFFER_ORIGINAL, pageUrl: PAGE_URL },
    }, sourceFetchPolicy(source.id), bodyQuality(source), extractor, classifier);

    expect(selection.body).toContain("Verified FT article paragraph 1");
    expect(selection.report.selectedOrigin).toBe("captured-page");
    expect(classifier).not.toHaveBeenCalled();

    const rawPageObject = "raw/ft/runs/run-valid/pages/valid/metadata.json";
    const rawPageRoot = path.dirname(path.join(output, ...rawPageObject.split("/")));
    await mkdir(rawPageRoot, { recursive: true });
    await writeFile(path.join(rawPageRoot, "rendered.html.gz"), gzipSync(VALID_RENDERED));
    await writeFile(path.join(rawPageRoot, "metadata.json"), JSON.stringify({
      formatVersion: "jojo-raw-page/1",
      finalUrl: PAGE_URL,
      renderedHtml: "rendered.html.gz",
      originalHtml: "not-restored.html.gz",
    }));
    const processed = await processArticle(
      output,
      source,
      candidate(source, rawPageObject, "captured"),
      sourceFetchPolicy(source.id),
      extractor,
      classifier,
    );
    expect(processed.processedBody).toContain("Verified FT article paragraph 1");
    expect(classifier).not.toHaveBeenCalled();
  });

  it("keeps ordinary missing pages non-terminal and still permits discovery fallback", async () => {
    const source = await ftSource();
    const selection = selectArticleBody({
      capturedPage: { html: RENDERED_WITHOUT_ARTICLE, pageUrl: PAGE_URL },
      originalPage: { html: "<html><body><p>Ordinary publisher shell.</p></body></html>", pageUrl: PAGE_URL },
      discoveryBody: { html: VALID_RENDERED, pageUrl: PAGE_URL },
    }, sourceFetchPolicy(source.id), bodyQuality(source), sourceBodyExtractor(source.id), sourceOriginalPageRejectionClassifier(source.id));

    expect(selection.body).toContain("Verified FT article paragraph 1");
    expect(selection.report.selectedOrigin).toBe("discovery-body");
    expect(selection.report.attempts).not.toContainEqual(expect.objectContaining({ origin: "original-page" }));
  });

  it("does not duplicate terminal evidence when direct capture stores identical HTML", async () => {
    const source = await ftSource();
    const directOffer = `<html><body><article>${CONSUMER_OFFER_BLOCKS}</article></body></html>`;
    const actualClassifier = sourceOriginalPageRejectionClassifier(source.id);
    const classifier = vi.fn(actualClassifier);

    const selection = selectArticleBody({
      capturedPage: { html: directOffer, pageUrl: PAGE_URL },
      originalPage: { html: directOffer, pageUrl: PAGE_URL },
      discoveryBody: { html: VALID_RENDERED, pageUrl: PAGE_URL },
    }, sourceFetchPolicy(source.id), bodyQuality(source), sourceBodyExtractor(source.id), classifier);

    expect(selection.body).toBeUndefined();
    expect(selection.report.attempts).toEqual([
      expect.objectContaining({
        origin: "captured-page",
        completeness: "truncated",
        rejectReason: "publisher-truncated",
        evidence: expect.objectContaining({ kind: "access-offer", matchedSignals: 4 }),
      }),
    ]);
    expect(classifier).not.toHaveBeenCalled();
  });

  it("does not read Raw HTML for hard-paywall candidates", async () => {
    const source = await ftSource();
    const hardPaywall = candidate(source, "raw/ft/missing/metadata.json", "hard-paywall");

    await expect(processArticle(
      "missing-output-root",
      source,
      hardPaywall,
      sourceFetchPolicy(source.id),
      sourceBodyExtractor(source.id),
      sourceOriginalPageRejectionClassifier(source.id),
    )).resolves.toEqual(hardPaywall);
  });
});
