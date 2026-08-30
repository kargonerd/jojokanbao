import { load } from "cheerio";
import type { PageImageCandidate } from "../../capture/page-images.js";
import { nikkeiArticleAccess, nikkeiPageData } from "./process.js";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizedText(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

function absoluteUrl(value: string | undefined, pageUrl: string): string | undefined {
  if (!value || value.startsWith("data:") || value.startsWith("blob:")) return undefined;
  try {
    const url = new URL(value, pageUrl);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function dimension(value: string | undefined): number | undefined {
  const parsed = Number(value?.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function extractNikkeiImages(html: string, pageUrl: string): PageImageCandidate[] {
  const pageData = nikkeiPageData(html);
  if (!pageData) return [];
  const images: PageImageCandidate[] = [];
  const seen = new Set<string>();
  const lead = object(pageData.image);
  const document = load(html);
  const renderedLead = document("[class*='NewsArticleHeaderImage'] img").first();
  const leadUrl = absoluteUrl(
    renderedLead.attr("src") ?? string(lead?.imageUrl),
    pageUrl,
  );
  if (leadUrl) {
    seen.add(leadUrl);
    const alt = normalizedText(renderedLead.attr("alt") ?? string(lead?.name) ?? "") || undefined;
    const caption = string(lead?.fullCaption) ?? string(lead?.caption);
    const width = dimension(renderedLead.attr("width"));
    const height = dimension(renderedLead.attr("height"));
    images.push({
      sourceUrl: leadUrl,
      role: "lead",
      ...(alt ? { alt } : {}),
      ...(caption ? { caption } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
    });
  }

  const embeddedBody = string(pageData.body);
  if (!embeddedBody) return images;
  const body = load(embeddedBody, undefined, false);
  const blocks = new Set(["blockquote", "h2", "h3", "h4", "ol", "p", "pre", "ul"]);
  const hasExtractedSubhead = nikkeiArticleAccess(html) === true && Boolean(string(pageData.subhead));
  let blockCount = hasExtractedSubhead ? 1 : 0;
  body.root().find("p,h2,h3,h4,blockquote,ul,ol,pre,img").each((_, element) => {
    const node = body(element);
    if (node.is("img")) {
      const sourceUrl = absoluteUrl(node.attr("full") ?? node.attr("data-src") ?? node.attr("src"), pageUrl);
      if (!sourceUrl || seen.has(sourceUrl)) return;
      seen.add(sourceUrl);
      const alt = normalizedText(node.attr("alt") ?? "") || undefined;
      const width = dimension(node.attr("width"));
      const height = dimension(node.attr("height"));
      images.push({
        sourceUrl,
        role: "content",
        afterBlock: blockCount,
        ...(alt ? { alt } : {}),
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
      });
      return;
    }
    if (!node.parents("p,h2,h3,h4,blockquote,ul,ol,pre").length
      && blocks.has(element.tagName.toLowerCase())
      && normalizedText(node.text())) blockCount += 1;
  });
  return images;
}
