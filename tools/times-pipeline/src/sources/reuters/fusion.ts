import { load } from "cheerio";

export type ReutersJsonObject = Record<string, unknown>;

export function reutersObject(value: unknown): ReutersJsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as ReutersJsonObject
    : undefined;
}

export function reutersFusionResult(html: string): ReutersJsonObject | undefined {
  const document = load(html);
  const script = document("script#fusion-metadata").text();
  const marker = "Fusion.globalContent=";
  const start = script.indexOf(marker);
  if (start < 0) return undefined;
  const jsonStart = start + marker.length;
  const jsonEnd = script.indexOf(";Fusion.", jsonStart);
  if (jsonEnd < 0) return undefined;
  try {
    return reutersObject(reutersObject(JSON.parse(script.slice(jsonStart, jsonEnd)))?.result);
  } catch {
    return undefined;
  }
}
