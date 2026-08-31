import { load } from "cheerio";
import type { SourceConfig, SourceFetchPolicy } from "../types.js";
import {
  prepareSemanticHtmlBlocks,
  prepareSemanticParagraphs,
  type BodyQuality,
  type SemanticBody,
} from "./paragraphs.js";

type JsonObject = Record<string, unknown>;

export type ArticleBodyCompleteness = "publisher-complete" | "unknown" | "truncated";

export interface PublisherBodyEvidence {
  kind: string;
  marker?: string;
  location?: string;
  [key: string]: string | number | boolean | undefined;
}

export type ArticleBodyExtraction =
  | {
      html: string;
      completeness: "publisher-complete";
      evidence: PublisherBodyEvidence;
    }
  | {
      html: string;
      completeness: "unknown";
      evidence?: PublisherBodyEvidence;
    }
  | {
      html: string;
      completeness: "truncated";
      evidence: PublisherBodyEvidence;
    };

export type ArticleBodyExtractor = (
  html: string,
  quality: BodyQuality,
  pageUrl?: string,
) => string | ArticleBodyExtraction | undefined;

export type ArticleBodyOrigin = "captured-page" | "discovery-body";
export type ArticleBodyExtractionPath =
  | "publisher-extractor"
  | "publisher-extractor-legacy"
  | "source-selector"
  | "json-ld"
  | "generic-selector"
  | "none";
export type ArticleBodyRejectReason =
  | "empty-input"
  | "not-extracted"
  | "publisher-truncated"
  | "below-sanitation-floor"
  | "below-quality-threshold";

export interface ArticleBodyAssessmentDiagnostic {
  origin: ArticleBodyOrigin;
  extractionPath: ArticleBodyExtractionPath;
  completeness: ArticleBodyCompleteness;
  characters: number;
  contentBlocks: number;
  minimumCharacters: number;
  minimumContentBlocks: number;
  verdict: "accepted" | "rejected";
  evidence?: PublisherBodyEvidence;
  rejectReason?: ArticleBodyRejectReason;
}

export interface ArticleBodyAssessment extends ArticleBodyAssessmentDiagnostic {
  body?: string;
}

export interface ArticleBodyAssessmentReport {
  attempts: ArticleBodyAssessmentDiagnostic[];
  selectedOrigin?: ArticleBodyOrigin;
}

export interface ArticleBodySelection {
  body?: string;
  assessment?: ArticleBodyAssessment;
  report: ArticleBodyAssessmentReport;
}

export interface ArticleBodyInput {
  html: string;
  pageUrl?: string;
}

export interface AvailableArticleBodies {
  capturedPage?: ArticleBodyInput;
  discoveryBody?: ArticleBodyInput;
}

const PUBLISHER_COMPLETE_FLOOR = {
  minimumCharacters: 20,
  minimumParagraphs: 1,
} satisfies Required<BodyQuality>;

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function articleBodies(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(articleBodies);
  const row = object(value);
  if (!row) return [];
  return [
    ...(typeof row.articleBody === "string" ? [row.articleBody] : []),
    ...Object.values(row).flatMap(articleBodies),
  ];
}

function extraction(value: string | ArticleBodyExtraction): ArticleBodyExtraction | undefined {
  if (typeof value === "string") return undefined;
  return value;
}

function thresholds(quality: BodyQuality): Required<BodyQuality> {
  return {
    minimumCharacters: quality.minimumCharacters ?? 800,
    minimumParagraphs: quality.minimumParagraphs ?? 3,
  };
}

function diagnostic(assessment: ArticleBodyAssessment): ArticleBodyAssessmentDiagnostic {
  const { body: _body, ...value } = assessment;
  return value;
}

function rejected(
  origin: ArticleBodyOrigin,
  extractionPath: ArticleBodyExtractionPath,
  quality: Required<BodyQuality>,
  rejectReason: ArticleBodyRejectReason,
  body?: SemanticBody,
  completeness: ArticleBodyCompleteness = "unknown",
  evidence?: PublisherBodyEvidence,
): ArticleBodyAssessment {
  return {
    origin,
    extractionPath,
    completeness,
    characters: body?.characters ?? 0,
    contentBlocks: body?.contentBlocks ?? 0,
    minimumCharacters: quality.minimumCharacters,
    minimumContentBlocks: quality.minimumParagraphs,
    verdict: "rejected",
    ...(evidence ? { evidence } : {}),
    rejectReason,
  };
}

function assessPrepared(
  body: SemanticBody | undefined,
  origin: ArticleBodyOrigin,
  extractionPath: ArticleBodyExtractionPath,
  quality: Required<BodyQuality>,
  completeness: ArticleBodyCompleteness = "unknown",
  evidence?: PublisherBodyEvidence,
): ArticleBodyAssessment {
  if (!body) {
    return rejected(
      origin,
      extractionPath,
      quality,
      completeness === "publisher-complete" ? "below-sanitation-floor" : "not-extracted",
      undefined,
      completeness,
      evidence,
    );
  }
  if (body.characters < quality.minimumCharacters || body.contentBlocks < quality.minimumParagraphs) {
    return rejected(
      origin,
      extractionPath,
      quality,
      completeness === "publisher-complete" ? "below-sanitation-floor" : "below-quality-threshold",
      body,
      completeness,
      evidence,
    );
  }
  return {
    origin,
    extractionPath,
    completeness,
    characters: body.characters,
    contentBlocks: body.contentBlocks,
    minimumCharacters: quality.minimumCharacters,
    minimumContentBlocks: quality.minimumParagraphs,
    verdict: "accepted",
    ...(evidence ? { evidence } : {}),
    body: body.html,
  };
}

function betterBody(
  current: ArticleBodyAssessment | undefined,
  candidate: ArticleBodyAssessment,
): ArticleBodyAssessment {
  if (!current) return candidate;
  if (candidate.verdict !== current.verdict) return candidate.verdict === "accepted" ? candidate : current;
  if (candidate.verdict === "accepted" && current.verdict === "accepted") {
    return (candidate.body?.length ?? 0) > (current.body?.length ?? 0) ? candidate : current;
  }
  if (candidate.characters !== current.characters) return candidate.characters > current.characters ? candidate : current;
  return candidate.contentBlocks > current.contentBlocks ? candidate : current;
}

export function bodyQuality(source: SourceConfig): BodyQuality {
  return {
    ...(source.content.minimumFullCharacters !== undefined ? { minimumCharacters: source.content.minimumFullCharacters } : {}),
    ...(source.content.minimumFullParagraphs !== undefined ? { minimumParagraphs: source.content.minimumFullParagraphs } : {}),
  };
}

export function assessArticleBody(
  html: string,
  policy: SourceFetchPolicy | undefined,
  quality: BodyQuality,
  sourceExtractor: ArticleBodyExtractor | undefined,
  pageUrl: string | undefined,
  origin: ArticleBodyOrigin,
): ArticleBodyAssessment {
  const requiredQuality = thresholds(quality);
  if (!html.trim()) return rejected(origin, "none", requiredQuality, "empty-input");

  let bestRejected: ArticleBodyAssessment | undefined;
  const sourceBody = sourceExtractor?.(html, quality, pageUrl);
  if (sourceBody) {
    const structured = extraction(sourceBody);
    if (!structured) {
      // A string is the pre-contract source-extractor result. Keep its trusted
      // behavior for compatibility, but label it unknown so it cannot be
      // mistaken for publisher completeness in diagnostics.
      const prepared = prepareSemanticHtmlBlocks([sourceBody as string], pageUrl);
      return {
        origin,
        extractionPath: "publisher-extractor-legacy",
        completeness: "unknown",
        characters: prepared?.characters ?? load(sourceBody as string, undefined, false).root().text().replaceAll(/\s+/gu, " ").trim().length,
        contentBlocks: prepared?.contentBlocks ?? 0,
        minimumCharacters: requiredQuality.minimumCharacters,
        minimumContentBlocks: requiredQuality.minimumParagraphs,
        verdict: "accepted",
        body: sourceBody as string,
      };
    } else {
      const prepared = prepareSemanticHtmlBlocks([structured.html], pageUrl);
      if (structured.completeness === "truncated") {
        return rejected(
          origin,
          "publisher-extractor",
          requiredQuality,
          "publisher-truncated",
          prepared,
          structured.completeness,
          structured.evidence,
        );
      }
      const structuredQuality = structured.completeness === "publisher-complete"
        ? PUBLISHER_COMPLETE_FLOOR
        : requiredQuality;
      const assessed = assessPrepared(
        prepared,
        origin,
        "publisher-extractor",
        structuredQuality,
        structured.completeness,
        structured.evidence,
      );
      if (structured.completeness === "publisher-complete" || assessed.verdict === "accepted") return assessed;
      bestRejected = betterBody(bestRejected, assessed);
    }
  }

  const document = load(html);
  const jsonBodies: string[] = [];
  document('script[type="application/ld+json"]').each((_, element) => {
    try {
      jsonBodies.push(...articleBodies(JSON.parse(document(element).text())));
    } catch {
      // Continue with source-owned DOM selectors.
    }
  });
  document("script, style, nav, footer, header, aside, form, noscript").remove();

  const bestBody = (
    selectors: readonly string[],
    completeContainerFallback: boolean,
    extractionPath: "source-selector" | "generic-selector",
  ): ArticleBodyAssessment | undefined => {
    let best: ArticleBodyAssessment | undefined;
    for (const selector of selectors) {
      const values: string[] = [];
      document(selector).each((_, container) => {
        const elements = document(container).find("p, h2, h3, h4, blockquote, ul, ol, pre").toArray();
        if (elements.length) values.push(...elements.map((element) => document.html(element)));
        else values.push(`<p>${document(container).html() ?? document(container).text()}</p>`);
      });
      const semantic = assessPrepared(
        prepareSemanticHtmlBlocks(values, pageUrl),
        origin,
        extractionPath,
        requiredQuality,
      );
      best = betterBody(best, semantic);
      if (semantic.verdict === "rejected" && completeContainerFallback) {
        const completeContainers = document(selector).toArray().map((container) => document(container).text());
        best = betterBody(best, assessPrepared(
          prepareSemanticParagraphs(completeContainers),
          origin,
          extractionPath,
          requiredQuality,
        ));
      }
    }
    return best;
  };

  const sourceSelectors = bestBody(policy?.bodySelectors ?? [], true, "source-selector");
  if (sourceSelectors?.verdict === "accepted") return sourceSelectors;
  if (sourceSelectors) bestRejected = betterBody(bestRejected, sourceSelectors);

  const jsonBody = jsonBodies.toSorted((left, right) => right.length - left.length)[0];
  if (jsonBody) {
    const assessedJson = assessPrepared(
      prepareSemanticParagraphs(jsonBody.split(/\r?\n(?:\s*\r?\n)*/u)),
      origin,
      "json-ld",
      requiredQuality,
    );
    if (assessedJson.verdict === "accepted") return assessedJson;
    bestRejected = betterBody(bestRejected, assessedJson);
  }

  const genericSelectors = bestBody([
    "[itemprop='articleBody']",
    "article",
    ".article-body",
    ".article__body",
    ".story-body",
    ".storytext",
    ".entry-content",
    ".post-content",
    "main",
  ], false, "generic-selector");
  if (genericSelectors?.verdict === "accepted") return genericSelectors;
  if (genericSelectors) bestRejected = betterBody(bestRejected, genericSelectors);

  return bestRejected ?? rejected(origin, "none", requiredQuality, "not-extracted");
}

export function selectArticleBody(
  inputs: AvailableArticleBodies,
  policy?: SourceFetchPolicy,
  quality: BodyQuality = {},
  sourceExtractor?: ArticleBodyExtractor,
): ArticleBodySelection {
  const attempts: ArticleBodyAssessment[] = [];
  if (inputs.capturedPage) {
    attempts.push(assessArticleBody(
      inputs.capturedPage.html,
      policy,
      quality,
      sourceExtractor,
      inputs.capturedPage.pageUrl,
      "captured-page",
    ));
  }
  const terminalRejection = attempts.some((attempt) => attempt.rejectReason === "publisher-truncated");
  if (!terminalRejection
    && !attempts.some((attempt) => attempt.verdict === "accepted")
    && inputs.discoveryBody) {
    attempts.push(assessArticleBody(
      inputs.discoveryBody.html,
      policy,
      quality,
      sourceExtractor,
      inputs.discoveryBody.pageUrl,
      "discovery-body",
    ));
  }
  const assessment = attempts.find((attempt) => attempt.verdict === "accepted");
  return {
    ...(assessment?.body ? { body: assessment.body, assessment } : {}),
    report: {
      attempts: attempts.map(diagnostic),
      ...(assessment ? { selectedOrigin: assessment.origin } : {}),
    },
  };
}

export function extractArticleBody(
  html: string,
  policy?: SourceFetchPolicy,
  quality: BodyQuality = {},
  sourceExtractor?: ArticleBodyExtractor,
  pageUrl?: string,
): string | undefined {
  return assessArticleBody(html, policy, quality, sourceExtractor, pageUrl, "captured-page").body;
}

export function hasArticleBody(
  html: string,
  policy?: SourceFetchPolicy,
  quality: BodyQuality = {},
  sourceExtractor?: ArticleBodyExtractor,
  pageUrl?: string,
): boolean {
  return assessArticleBody(html, policy, quality, sourceExtractor, pageUrl, "captured-page").verdict === "accepted";
}
