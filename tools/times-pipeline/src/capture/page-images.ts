import type { JojoAssetPresentation } from "@jojo/content";

export interface PageImageCandidate {
  sourceUrl: string;
  role: "lead" | "content";
  alt?: string;
  caption?: string;
  width?: number;
  height?: number;
  afterBlock?: number;
  credit?: string;
  presentation?: JojoAssetPresentation;
}

export type ArticleImageExtractor = (html: string, pageUrl: string) => PageImageCandidate[];

function absoluteImageUrl(value: string | undefined, pageUrl: string): string | undefined {
  if (!value || value.startsWith("data:") || value.startsWith("blob:")) return undefined;
  try {
    const url = new URL(value, pageUrl);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function normalizedCandidate(candidate: PageImageCandidate, pageUrl: string): PageImageCandidate | undefined {
  const sourceUrl = absoluteImageUrl(candidate.sourceUrl, pageUrl);
  if (!sourceUrl) return undefined;
  const { width, height } = candidate;
  if ((width !== undefined && width <= 80) || (height !== undefined && height <= 80)) return undefined;
  return { ...candidate, sourceUrl };
}

function collectImageCandidates(
  candidates: Iterable<PageImageCandidate>,
  pageUrl: string,
): PageImageCandidate[] {
  const values = new Map<string, PageImageCandidate>();
  for (const rawCandidate of candidates) {
    const candidate = normalizedCandidate(rawCandidate, pageUrl);
    if (!candidate) continue;
    const previous = values.get(candidate.sourceUrl);
    const alt = candidate.alt ?? previous?.alt;
    const caption = candidate.caption ?? previous?.caption;
    const credit = candidate.credit ?? previous?.credit;
    values.set(candidate.sourceUrl, {
      ...previous,
      ...candidate,
      role: previous?.role === "lead" || candidate.role === "lead" ? "lead" : "content",
      ...(alt ? { alt } : {}),
      ...(caption ? { caption } : {}),
      ...(credit ? { credit } : {}),
    });
  }
  return [...values.values()];
}

export function discoverArticleImages(
  html: string,
  pageUrl: string,
  sourceExtractor: ArticleImageExtractor,
): PageImageCandidate[] {
  return collectImageCandidates(sourceExtractor(html, pageUrl), pageUrl);
}
