import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  ContentPriority,
  DiscoveryConfig,
  DiscoveryEndpoint,
  PublisherSectionConfig,
  RouteSourceAdapter,
  SourceConfig,
} from "./types.js";

const SOURCE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PRIORITIES = new Set<ContentPriority>(["discovery-body", "browser-parser", "discovery-summary"]);
const ROUTE_SOURCE_ADAPTERS = new Set<RouteSourceAdapter>([
  "africanews",
  "agencia-brasil",
  "aljazeera-english",
  "chinanews",
  "cna-singapore",
  "people",
  "thepaper",
  "xinhua",
  "zaobao",
]);

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

function parseDiscoveryEndpoint(value: unknown, field: string): DiscoveryEndpoint {
  if (!value || typeof value !== "object") throw new Error(`${field} must be an object`);
  const row = value as Record<string, unknown>;
  const kind = requiredString(row.kind, `${field}.kind`);
  if (kind === "source-adapter") {
    const adapter = requiredString(row.adapter, `${field}.adapter`);
    const driver = requiredString(row.driver, `${field}.driver`);
    if (driver !== "http" && driver !== "browser") throw new Error(`${field}.driver must be http or browser`);
    const maximumItems = row.maximumItems;
    if (!Number.isInteger(maximumItems) || (maximumItems as number) < 1 || (maximumItems as number) > 100) {
      throw new Error(`${field}.maximumItems must be an integer from 1 to 100`);
    }
    if (adapter === "ap") {
      const sectionPath = requiredString(row.path, `${field}.path`);
      if (!sectionPath.startsWith("/")) throw new Error(`${field}.path must start with /`);
      return { kind, adapter, driver, path: sectionPath, maximumItems: maximumItems as number };
    }
    if (adapter === "nikkei") {
      if (row.stream !== undefined) {
        const stream = requiredString(row.stream, `${field}.stream`);
        if (stream !== "latest") throw new Error(`${field}.stream must be latest`);
        return { kind, adapter, driver, stream, maximumItems: maximumItems as number };
      }
      return {
        kind,
        adapter,
        driver,
        route: requiredString(row.route, `${field}.route`),
        maximumItems: maximumItems as number,
      };
    }
    if (adapter === "cls") {
      const categoryId = requiredString(row.categoryId, `${field}.categoryId`);
      if (!/^\d+$/u.test(categoryId)) throw new Error(`${field}.categoryId must contain only digits`);
      return { kind, adapter, driver, categoryId, maximumItems: maximumItems as number };
    }
    if (adapter === "dw") {
      const navigationId = requiredString(row.navigationId, `${field}.navigationId`);
      if (!/^\d+$/u.test(navigationId)) throw new Error(`${field}.navigationId must contain only digits`);
      return { kind, adapter, driver, navigationId, maximumItems: maximumItems as number };
    }
    if (ROUTE_SOURCE_ADAPTERS.has(adapter as RouteSourceAdapter)) {
      return {
        kind,
        adapter: adapter as RouteSourceAdapter,
        driver,
        route: requiredString(row.route, `${field}.route`),
        maximumItems: maximumItems as number,
      };
    }
    throw new Error(`${field}.adapter is unsupported: ${adapter}`);
  }
  if (kind === "official-rss-list") {
    if (!Array.isArray(row.urls) || row.urls.length === 0 || row.urls.length > 20) {
      throw new Error(`${field}.urls must contain 1 to 20 URLs`);
    }
    const urls = [...new Set(row.urls.map((url, index) => credentialFreeHttpsUrl(url, `${field}.urls[${index}]`)))];
    return { kind, urls };
  }
  if (kind === "official-rss" || kind === "sitemap") {
    const url = credentialFreeHttpsUrl(row.url, `${field}.url`);
    if (kind === "sitemap") {
      const maximumPages = row.maximumPages;
      if (!Number.isInteger(maximumPages) || (maximumPages as number) < 1 || (maximumPages as number) > 100) {
        throw new Error(`${field}.maximumPages must be an integer from 1 to 100`);
      }
      return { kind, url, maximumPages: maximumPages as number };
    }
    return { kind, url };
  }
  throw new Error(`${field}.kind is unsupported: ${kind}`);
}

function parseDiscovery(value: unknown, sourceId: string, sectionIds: Set<string>): DiscoveryConfig {
  if (!value || typeof value !== "object") throw new Error(`${sourceId}.discovery must be an object`);
  const row = value as Record<string, unknown>;
  if (row.kind !== "multi") return parseDiscoveryEndpoint(value, `${sourceId}.discovery`);
  if (!Array.isArray(row.targets) || row.targets.length === 0 || row.targets.length > 100) {
    throw new Error(`${sourceId}.discovery.targets must contain 1 to 100 targets`);
  }
  const seen = new Set<string>();
  const targets = row.targets.map((value, index) => {
    if (!value || typeof value !== "object") throw new Error(`${sourceId}.discovery.targets[${index}] must be an object`);
    const target = value as Record<string, unknown>;
    const id = requiredString(target.id, `${sourceId}.discovery.targets[${index}].id`);
    if (!SOURCE_ID.test(id)) throw new Error(`${sourceId}.discovery target id is invalid: ${id}`);
    if (seen.has(id)) throw new Error(`${sourceId}.discovery target id is duplicated: ${id}`);
    seen.add(id);
    if (!Array.isArray(target.sectionIds)) throw new Error(`${sourceId}.${id}.sectionIds must be an array`);
    const selected = [...new Set(target.sectionIds.map((item, position) => requiredString(item, `${sourceId}.${id}.sectionIds[${position}]`)))];
    for (const sectionId of selected) {
      if (!sectionIds.has(sectionId)) throw new Error(`${sourceId}.${id} references unknown section: ${sectionId}`);
    }
    return {
      id,
      sectionIds: selected,
      ...(target.fallback === true ? { fallback: true } : {}),
      discovery: parseDiscoveryEndpoint(target.discovery, `${sourceId}.discovery.targets[${index}].discovery`),
    };
  });
  return { kind: "multi", targets };
}

function parseSections(value: unknown, sourceId: string): PublisherSectionConfig[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new Error(`${sourceId}.sections must contain 1 to 100 sections`);
  }
  const seen = new Set<string>();
  return value.map((value, index) => {
    if (!value || typeof value !== "object") throw new Error(`${sourceId}.sections[${index}] must be an object`);
    const row = value as Record<string, unknown>;
    const id = requiredString(row.id, `${sourceId}.sections[${index}].id`);
    if (!SOURCE_ID.test(id)) throw new Error(`${sourceId}.section id is invalid: ${id}`);
    if (seen.has(id)) throw new Error(`${sourceId}.section id is duplicated: ${id}`);
    seen.add(id);
    let match: PublisherSectionConfig["match"];
    if (row.match !== undefined) {
      if (!row.match || typeof row.match !== "object") throw new Error(`${sourceId}.${id}.match must be an object`);
      const rawMatch = row.match as Record<string, unknown>;
      const urlPrefixes = rawMatch.urlPrefixes === undefined ? undefined : (() => {
        if (!Array.isArray(rawMatch.urlPrefixes)) throw new Error(`${sourceId}.${id}.match.urlPrefixes must be an array`);
        return [...new Set(rawMatch.urlPrefixes.map((url, position) => credentialFreeHttpsUrl(url, `${sourceId}.${id}.match.urlPrefixes[${position}]`)))];
      })();
      const publisherCategories = rawMatch.publisherCategories === undefined ? undefined : (() => {
        if (!Array.isArray(rawMatch.publisherCategories)) throw new Error(`${sourceId}.${id}.match.publisherCategories must be an array`);
        return [...new Set(rawMatch.publisherCategories.map((item, position) => requiredString(item, `${sourceId}.${id}.match.publisherCategories[${position}]`)))];
      })();
      match = {
        ...(urlPrefixes?.length ? { urlPrefixes } : {}),
        ...(publisherCategories?.length ? { publisherCategories } : {}),
      };
    }
    return {
      id,
      name: requiredString(row.name, `${sourceId}.${id}.name`),
      url: credentialFreeHttpsUrl(row.url, `${sourceId}.${id}.url`),
      ...(row.discoverable === false ? { discoverable: false } : {}),
      ...(match && Object.keys(match).length ? { match } : {}),
    };
  });
}

function parseSource(value: unknown, position: number): SourceConfig | null {
  if (!value || typeof value !== "object") throw new Error(`sources[${position}] must be an object`);
  const row = value as Record<string, unknown>;
  if (row.enabled === false) return null;
  const id = requiredString(row.id, `sources[${position}].id`);
  if (!SOURCE_ID.test(id)) throw new Error(`${id}.id must use lowercase letters, numbers and hyphens`);
  const sections = parseSections(row.sections, id);
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
  if (minimumFullCharacters !== undefined && (!Number.isInteger(minimumFullCharacters) || (minimumFullCharacters as number) < 0)) {
    throw new Error(`${id}.content.minimumFullCharacters must be a non-negative integer`);
  }
  if (minimumFullParagraphs !== undefined && (!Number.isInteger(minimumFullParagraphs) || (minimumFullParagraphs as number) < 0)) {
    throw new Error(`${id}.content.minimumFullParagraphs must be a non-negative integer`);
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
    ...(sections ? { sections } : {}),
    discovery: parseDiscovery(row.discovery, id, new Set(sections?.map((section) => section.id) ?? [])),
    content: {
      priority: [...priorities] as ContentPriority[],
      ...(parser ? { parser } : {}),
      ...(minimumFullCharacters !== undefined ? { minimumFullCharacters: minimumFullCharacters as number } : {}),
      ...(minimumFullParagraphs !== undefined ? { minimumFullParagraphs: minimumFullParagraphs as number } : {}),
    },
    archive: { mode: mode as SourceConfig["archive"]["mode"], bpc: archive.bpc, ...(proxyPolicy ? { proxyPolicy } : {}) },
    health: { minimumCandidates: minimumCandidates as number },
    enabled: true,
  };
}

async function sourceRows(configPath: string): Promise<unknown[]> {
  const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
    version?: unknown;
    sources?: unknown;
    sourceFiles?: unknown;
  };
  if (parsed.version !== 2) throw new Error("Times sources must use config version 2");
  if (Array.isArray(parsed.sources)) return parsed.sources;
  if (!Array.isArray(parsed.sourceFiles) || parsed.sourceFiles.length === 0 || parsed.sourceFiles.length > 100) {
    throw new Error("Times sources must contain a sources array or 1 to 100 sourceFiles");
  }
  const configRoot = path.dirname(configPath);
  return Promise.all(parsed.sourceFiles.map(async (value, index) => {
    const relative = requiredString(value, `sourceFiles[${index}]`);
    if (path.isAbsolute(relative)) throw new Error(`sourceFiles[${index}] must be relative to the catalog`);
    const sourcePath = path.resolve(configRoot, relative);
    if (sourcePath !== configRoot && !sourcePath.startsWith(`${configRoot}${path.sep}`)) {
      throw new Error(`sourceFiles[${index}] must stay inside the catalog directory`);
    }
    return JSON.parse(await readFile(sourcePath, "utf8")) as unknown;
  }));
}

export async function loadSources(configPath: string): Promise<SourceConfig[]> {
  const rows = await sourceRows(path.resolve(configPath));
  const sources = rows.map(parseSource).filter((source): source is SourceConfig => source !== null);
  const seen = new Set<string>();
  for (const source of sources) {
    if (seen.has(source.id)) throw new Error(`Duplicate source id: ${source.id}`);
    seen.add(source.id);
  }
  if (sources.length === 0) throw new Error("Times sources must enable at least one source");
  return sources;
}
