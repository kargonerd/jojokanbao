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

export type PublisherDateMode = "auto" | "wall-clock";

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

function localDateParts(value: string): LocalDateParts | undefined {
  const iso = value.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?/u);
  const chinese = value.match(/(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s*(\d{1,2}):(\d{2})(?::(\d{2}))?)?/u);
  const dayFirst = value.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(?:[-–]\s*)?(\d{1,2}):(\d{2})(?::(\d{2}))?/u);
  const english = value.match(/(?:[A-Za-z]{3},?\s+)?(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/u);
  const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const match = iso ?? chinese;
  if (!match && english) {
    const month = monthNames.indexOf(english[2]!.slice(0, 3).toLowerCase()) + 1;
    if (month === 0) return undefined;
    return validatedLocalDateParts({
      year: Number(english[3]),
      month,
      day: Number(english[1]),
      hour: Number(english[4]),
      minute: Number(english[5]),
      second: Number(english[6] ?? "0"),
      millisecond: 0,
    });
  }
  if (!match && dayFirst) {
    return validatedLocalDateParts({
      year: Number(dayFirst[3]),
      month: Number(dayFirst[2]),
      day: Number(dayFirst[1]),
      hour: Number(dayFirst[4]),
      minute: Number(dayFirst[5]),
      second: Number(dayFirst[6] ?? "0"),
      millisecond: 0,
    });
  }
  if (!match) return undefined;
  const [, year, month, day, hour = "0", minute = "0", second = "0", fraction = "0"] = match;
  return validatedLocalDateParts({
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
    millisecond: Number(fraction.padEnd(3, "0")),
  });
}

function validatedLocalDateParts(parts: LocalDateParts): LocalDateParts | undefined {
  const check = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond));
  if (check.getUTCFullYear() !== parts.year || check.getUTCMonth() + 1 !== parts.month || check.getUTCDate() !== parts.day
    || check.getUTCHours() !== parts.hour || check.getUTCMinutes() !== parts.minute || check.getUTCSeconds() !== parts.second) {
    return undefined;
  }
  return parts;
}

function zoneOffsetMilliseconds(instant: number, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    calendar: "iso8601",
    numberingSystem: "latn",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const values = Object.fromEntries(formatter.formatToParts(new Date(instant))
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, Number(part.value)]));
  const representedAsUtc = Date.UTC(
    values.year!,
    values.month! - 1,
    values.day!,
    values.hour!,
    values.minute!,
    values.second!,
  );
  return representedAsUtc - Math.floor(instant / 1_000) * 1_000;
}

function localDateInZone(parts: LocalDateParts, timeZone: string): string | undefined {
  const wallClock = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond);
  try {
    let instant = wallClock - zoneOffsetMilliseconds(wallClock, timeZone);
    instant = wallClock - zoneOffsetMilliseconds(instant, timeZone);
    return new Date(instant).toISOString();
  } catch {
    return undefined;
  }
}

function hasExplicitTimeZone(value: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})\s*$/iu.test(value)
    || /\b(?:UTC|GMT|EST|EDT|CST|CDT|MST|MDT|PST|PDT)\b/iu.test(value);
}

export function publisherDate(value: unknown, timeZone: string, mode: PublisherDateMode = "auto"): string | undefined {
  if (value instanceof Date || typeof value === "number") return isoDate(value);
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (!raw) return undefined;
  if (mode === "auto" && hasExplicitTimeZone(raw)) return isoDate(raw);
  const parts = localDateParts(raw);
  return parts ? localDateInZone(parts, timeZone) : undefined;
}
