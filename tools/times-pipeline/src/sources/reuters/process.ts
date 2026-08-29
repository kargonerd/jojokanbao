import { semanticHtmlBlocks, type BodyQuality } from "../../content/paragraphs.js";
import type { Candidate } from "../../types.js";
import { reutersFusionResult, reutersObject } from "./fusion.js";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function extractReutersBody(html: string, quality: BodyQuality, pageUrl?: string): string | undefined {
  const result = reutersFusionResult(html);
  const elements = Array.isArray(result?.content_elements) ? result.content_elements : [];
  const dateline = Array.isArray(result?.dateline)
    ? result.dateline.find((value): value is string => typeof value === "string" && Boolean(value.trim()))
    : undefined;
  const blocks: string[] = [];
  for (const value of elements) {
    const element = reutersObject(value);
    const content = typeof element?.content === "string" ? element.content.trim() : "";
    if (!content) continue;
    if (element?.type === "header") {
      blocks.push(`<h2>${content}</h2>`);
    } else if (element?.type === "paragraph") {
      const prefix = blocks.length === 0 && dateline ? `${escapeHtml(dateline)} - ` : "";
      blocks.push(`<p>${prefix}${content}</p>`);
    }
  }
  return semanticHtmlBlocks(blocks, quality, pageUrl);
}

export function processReuters(candidate: Candidate): Candidate {
  return { ...candidate, publisherCategories: [...new Set(candidate.publisherCategories)] };
}
