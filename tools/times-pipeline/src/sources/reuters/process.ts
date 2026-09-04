import { semanticHtmlBlocks, type BodyQuality } from "../../content/paragraphs.js";
import type { Candidate } from "../../types.js";
import { reutersFusionResult, reutersObject } from "./fusion.js";

export function isReutersLiveBlogPage(html: string): boolean {
  const result = reutersFusionResult(html);
  if (result?.subtype === "live-blog") return true;
  const primaryTag = reutersObject(result?.primary_tag);
  if (primaryTag?.slug === "live-blog") return true;
  const elements = Array.isArray(result?.content_elements) ? result.content_elements : [];
  return elements.some((value) => reutersObject(value)?.type === "live-blog");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function listItem(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  const row = reutersObject(value);
  for (const candidate of [row?.content, row?.text, row?.value]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

export function extractReutersBody(html: string, quality: BodyQuality, pageUrl?: string): string | undefined {
  const result = reutersFusionResult(html);
  const elements = Array.isArray(result?.content_elements) ? result.content_elements : [];
  const dateline = Array.isArray(result?.dateline)
    ? result.dateline.find((value): value is string => typeof value === "string" && Boolean(value.trim()))
    : undefined;
  const blocks: string[] = [];
  let usedDateline = false;
  for (const value of elements) {
    const element = reutersObject(value);
    const content = typeof element?.content === "string" ? element.content.trim() : "";
    if (element?.type === "header") {
      if (content) blocks.push(`<h2>${content}</h2>`);
    } else if (element?.type === "paragraph") {
      if (!content) continue;
      const prefix = !usedDateline && dateline ? `${escapeHtml(dateline)} - ` : "";
      usedDateline = true;
      blocks.push(`<p>${prefix}${content}</p>`);
    } else if (["list", "ordered-list", "unordered-list"].includes(String(element?.type))) {
      const rawItems = [element?.items, element?.list_items, element?.content].find(Array.isArray) ?? [];
      const items = rawItems.map(listItem).filter((item): item is string => Boolean(item));
      if (items.length) {
        const tag = element?.type === "ordered-list" || element?.ordered === true ? "ol" : "ul";
        blocks.push(`<${tag}>${items.map((item) => `<li>${item}</li>`).join("")}</${tag}>`);
      }
    } else if (["quote", "blockquote"].includes(String(element?.type)) && content) {
      blocks.push(`<blockquote>${content}</blockquote>`);
    }
  }
  return semanticHtmlBlocks(blocks, quality, pageUrl);
}

export function processReuters(candidate: Candidate): Candidate {
  return { ...candidate, publisherCategories: [...new Set(candidate.publisherCategories)] };
}
