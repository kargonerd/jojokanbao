export interface RenderedBodyQuality {
  minimumCharacters?: number;
  minimumParagraphs?: number;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function semanticParagraphs(
  values: string[],
  quality: RenderedBodyQuality = {},
): string | undefined {
  const seen = new Set<string>();
  const paragraphs = values.map((value) => value.replaceAll(/\s+/gu, " ").trim())
    .filter((value) => value.length >= 20 && !seen.has(value) && Boolean(seen.add(value)));
  const text = paragraphs.join("\n");
  const paywallHints = ["subscribe to continue", "sign in to continue", "register to continue", "already a subscriber"];
  if (text.length < (quality.minimumCharacters ?? 800) || paragraphs.length < (quality.minimumParagraphs ?? 3)) return undefined;
  if (text.length < 2_000 && paywallHints.some((hint) => text.toLowerCase().includes(hint))) return undefined;
  return paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("");
}
