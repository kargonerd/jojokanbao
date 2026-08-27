export interface BodyQuality {
  minimumCharacters?: number;
  minimumParagraphs?: number;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function semanticParagraphs(
  values: string[],
  quality: BodyQuality = {},
): string | undefined {
  const seen = new Set<string>();
  const accessBoilerplate = [
    "thank you for your patience while we verify access",
    "subscribe to continue",
    "sign in to continue",
    "register to continue",
    "already a subscriber",
    "want all of the times? subscribe",
  ];
  const paragraphs = values.map((value) => value.replaceAll(/\s+/gu, " ").trim())
    .filter((value) => value.length >= 20 && !accessBoilerplate.some((hint) => value.toLowerCase().includes(hint)))
    .filter((value) => !seen.has(value) && Boolean(seen.add(value)));
  const text = paragraphs.join("\n");
  if (text.length < (quality.minimumCharacters ?? 800) || paragraphs.length < (quality.minimumParagraphs ?? 3)) return undefined;
  return paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("");
}
