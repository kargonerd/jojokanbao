import { readFile } from "node:fs/promises";
import type { ContentPriority, DiscoveryConfig, SourceConfig } from "./types.js";

const SOURCE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PRIORITIES = new Set<ContentPriority>(["discovery-body", "browser-parser", "discovery-summary"]);

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function credentialFreeHttpsUrl(value: unknown, field: string): string {
  const url = requiredString(value, field);
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(`${field} must be a credential-free HTTPS URL`);
  }
  return url;
}

function parseDiscovery(value: unknown, sourceId: string): DiscoveryConfig {
  if (!value || typeof value !== "object") throw new Error(`${sourceId}.discovery must be an object`);
  const row = value as Record<string, unknown>;
  const kind = requiredString(row.kind, `${sourceId}.discovery.kind`);
  if (kind === "rsshub-package") {
    const route = requiredString(row.route, `${sourceId}.discovery.route`);
    if (!route.startsWith("/")) throw new Error(`${sourceId}.discovery.route must start with /`);
    return { kind, route };
  }
  if (kind === "official-rss-list") {
    if (!Array.isArray(row.urls) || row.urls.length === 0 || row.urls.length > 20) {
      throw new Error(`${sourceId}.discovery.urls must contain 1 to 20 URLs`);
    }
    const urls = [...new Set(row.urls.map((url, index) => credentialFreeHttpsUrl(url, `${sourceId}.discovery.urls[${index}]`)))];
    return { kind, urls };
  }
  if (kind === "official-rss" || kind === "sitemap") {
    const url = credentialFreeHttpsUrl(row.url, `${sourceId}.discovery.url`);
    if (kind === "sitemap") {
      const maximumPages = row.maximumPages;
      if (!Number.isInteger(maximumPages) || (maximumPages as number) < 1 || (maximumPages as number) > 100) {
        throw new Error(`${sourceId}.discovery.maximumPages must be an integer from 1 to 100`);
      }
      return { kind, url, maximumPages: maximumPages as number };
    }
    return { kind, url };
  }
  if (kind === "site-adapter") return { kind, adapter: requiredString(row.adapter, `${sourceId}.discovery.adapter`) };
  throw new Error(`${sourceId}.discovery.kind is unsupported: ${kind}`);
}

function parseSource(value: unknown, position: number): SourceConfig | null {
  if (!value || typeof value !== "object") throw new Error(`sources[${position}] must be an object`);
  const row = value as Record<string, unknown>;
  if (row.enabled === false) return null;
  const id = requiredString(row.id, `sources[${position}].id`);
  if (!SOURCE_ID.test(id)) throw new Error(`${id}.id must use lowercase letters, numbers and hyphens`);
  const content = row.content as Record<string, unknown> | undefined;
  const priorities = content?.priority;
  if (!Array.isArray(priorities) || priorities.length === 0 || priorities.some((item) => !PRIORITIES.has(item as ContentPriority))) {
    throw new Error(`${id}.content.priority is invalid`);
  }
  const archive = row.archive as Record<string, unknown> | undefined;
  const mode = archive?.mode;
  if (!new Set(["browser", "http", "none"]).has(mode as string)) throw new Error(`${id}.archive.mode is invalid`);
  if (typeof archive?.bpc !== "boolean") throw new Error(`${id}.archive.bpc must be a boolean`);
  const parser = typeof content?.parser === "string" && content.parser.trim() ? content.parser.trim() : undefined;
  const minimumFullCharacters = content?.minimumFullCharacters;
  const minimumFullParagraphs = content?.minimumFullParagraphs;
  const allowedHostnames = content?.allowedHostnames;
  const excludedPathPrefixes = content?.excludedPathPrefixes;
  if (minimumFullCharacters !== undefined && (!Number.isInteger(minimumFullCharacters) || (minimumFullCharacters as number) < 0)) {
    throw new Error(`${id}.content.minimumFullCharacters must be a non-negative integer`);
  }
  if (minimumFullParagraphs !== undefined && (!Number.isInteger(minimumFullParagraphs) || (minimumFullParagraphs as number) < 0)) {
    throw new Error(`${id}.content.minimumFullParagraphs must be a non-negative integer`);
  }
  if (allowedHostnames !== undefined && (
    !Array.isArray(allowedHostnames)
    || allowedHostnames.length === 0
    || allowedHostnames.some((hostname) => typeof hostname !== "string" || !hostname.trim() || hostname.includes("/"))
  )) {
    throw new Error(`${id}.content.allowedHostnames must contain hostnames`);
  }
  if (excludedPathPrefixes !== undefined && (
    !Array.isArray(excludedPathPrefixes)
    || excludedPathPrefixes.length === 0
    || excludedPathPrefixes.some((prefix) => typeof prefix !== "string" || !prefix.startsWith("/"))
  )) {
    throw new Error(`${id}.content.excludedPathPrefixes must contain absolute path prefixes`);
  }
  const proxyPolicy = typeof archive.proxyPolicy === "string" && archive.proxyPolicy.trim() ? archive.proxyPolicy.trim() : undefined;
  const health = row.health as Record<string, unknown> | undefined;
  const minimumCandidates = health?.minimumCandidates;
  if (!Number.isInteger(minimumCandidates) || (minimumCandidates as number) < 0) {
    throw new Error(`${id}.health.minimumCandidates must be a non-negative integer`);
  }
  return {
    id,
    name: requiredString(row.name, `${id}.name`),
    language: requiredString(row.language, `${id}.language`),
    discovery: parseDiscovery(row.discovery, id),
    content: {
      priority: [...priorities] as ContentPriority[],
      ...(parser ? { parser } : {}),
      ...(minimumFullCharacters !== undefined ? { minimumFullCharacters: minimumFullCharacters as number } : {}),
      ...(minimumFullParagraphs !== undefined ? { minimumFullParagraphs: minimumFullParagraphs as number } : {}),
      ...(allowedHostnames !== undefined
        ? { allowedHostnames: [...new Set((allowedHostnames as string[]).map((hostname) => hostname.trim().toLowerCase()))] }
        : {}),
      ...(excludedPathPrefixes !== undefined
        ? { excludedPathPrefixes: [...new Set(excludedPathPrefixes as string[])] }
        : {}),
    },
    archive: { mode: mode as SourceConfig["archive"]["mode"], bpc: archive.bpc, ...(proxyPolicy ? { proxyPolicy } : {}) },
    health: { minimumCandidates: minimumCandidates as number },
    enabled: true,
  };
}

export async function loadSources(path: string): Promise<SourceConfig[]> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as { version?: unknown; sources?: unknown };
  if (parsed.version !== 2 || !Array.isArray(parsed.sources)) throw new Error("Times sources must use config version 2");
  const sources = parsed.sources.map(parseSource).filter((source): source is SourceConfig => source !== null);
  const seen = new Set<string>();
  for (const source of sources) {
    if (seen.has(source.id)) throw new Error(`Duplicate source id: ${source.id}`);
    seen.add(source.id);
  }
  if (sources.length === 0) throw new Error("Times sources must enable at least one source");
  return sources;
}
