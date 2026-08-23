export function plainText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function removeParserArtifacts(value: string): string {
  return value.replace(/Unhandled type:\s*[\w-]+(?:\s+\{[^<\r\n]*\})?/g, " ");
}

export function isFullDiscoveryBody(
  value: string,
  minimumCharacters = 0,
  minimumParagraphs = 0,
): boolean {
  const characters = plainText(value).length;
  const paragraphs = (value.match(/<p\b/gi) ?? []).length;
  return characters >= minimumCharacters && paragraphs >= minimumParagraphs;
}

export function optionalString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  return undefined;
}

export function stringList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return [...new Set(values.flatMap((item) => {
    if (typeof item === "string") return item.split(",").map((part) => part.trim()).filter(Boolean);
    if (item && typeof item === "object") {
      const row = item as Record<string, unknown>;
      const candidate = optionalString(row.name) ?? optionalString(row.label) ?? optionalString(row._);
      return candidate ? [candidate] : [];
    }
    return [];
  }))];
}

export function isoDate(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString();
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}
