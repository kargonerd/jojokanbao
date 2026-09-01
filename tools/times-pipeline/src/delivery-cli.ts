import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { JojoCatalog, TimesSourceIndex, TimesTimelineDay, TimesTimelineIndex } from "@jojo/content";
import type { CanonicalWriteResult } from "./process/canonical-writer.js";
import { parseArgs, requiredArg } from "./args.js";
import { loadSources } from "./config.js";
import { buildNewsDelivery, readJoxJson } from "./delivery-writer.js";
import type { SourceConfig } from "./types.js";

export interface ProcessResult {
  report?: string;
  sources: CanonicalWriteResult[];
}

async function optionalJox<T>(root: string | undefined, objectKey: string): Promise<T | undefined> {
  if (!root) return undefined;
  try {
    return readJoxJson<T>(new Uint8Array(await readFile(path.join(path.resolve(root), ...objectKey.split("/")))), objectKey);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function booleanArg(args: Map<string, string>, name: string): boolean {
  const value = args.get(name);
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`--${name} must be true or false`);
}

export async function sourcesForDelivery(
  configured: readonly SourceConfig[],
  processResult: ProcessResult,
  includeArchiveSources: boolean,
  previousTimelineIndex?: TimesTimelineIndex,
): Promise<SourceConfig[]> {
  const configuredIds = new Set(configured.map((source) => source.id));
  const { archiveSourceConfig, isArchiveOnlySource } = await import("./archive/canonical.js");
  const archiveIds = new Set(
    previousTimelineIndex?.sources
      .map((source) => source.id)
      .filter((sourceId) => isArchiveOnlySource(sourceId))
      ?? [],
  );
  if (includeArchiveSources) {
    for (const source of processResult.sources) archiveIds.add(source.sourceId);
  }
  const missing = [...archiveIds]
    .filter((sourceId) => !configuredIds.has(sourceId))
    .sort();
  if (!missing.length) return [...configured];
  return [
    ...configured,
    ...missing.map((sourceId) => archiveSourceConfig(sourceId, configured)),
  ];
}

export async function runDelivery(args: Map<string, string>): Promise<{
  deliveryRoot: string;
  timelineIndexObject: string;
  articles: number;
  sources: number;
  dates: string[];
}> {
  const workspaceRoot = path.resolve(requiredArg(args, "output"));
  const configPath = path.resolve(requiredArg(args, "config"));
  const processResult = JSON.parse(await readFile(path.resolve(requiredArg(args, "process-result")), "utf8")) as ProcessResult;
  const deliveryRoot = path.resolve(args.get("delivery-output") ?? path.join(workspaceRoot, "delivery"));
  const previousRoot = args.get("previous-delivery");
  const generatedAt = args.get("generated-at") ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(generatedAt))) throw new Error("--generated-at must be an ISO timestamp");
  const previousTimelineIndex = await optionalJox<TimesTimelineIndex>(previousRoot, "content/timeline/index.jox");
  const sources = await sourcesForDelivery(
    await loadSources(configPath),
    processResult,
    booleanArg(args, "archive-sources"),
    previousTimelineIndex,
  );
  const dates = new Set(processResult.sources.flatMap((source) => source.dates));
  const previousTimelineDays = new Map<string, TimesTimelineDay>();
  for (const date of dates) {
    const object = `content/timeline/dates/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.jox`;
    const day = await optionalJox<TimesTimelineDay>(previousRoot, object);
    if (day) previousTimelineDays.set(date, day);
  }
  const previousSourceIndexes = new Map<string, TimesSourceIndex>();
  for (const source of sources) {
    const index = await optionalJox<TimesSourceIndex>(previousRoot, `content/newspapers/${source.id}/index.jox`);
    if (index) previousSourceIndexes.set(source.id, index);
  }
  const previousCatalog = await optionalJox<JojoCatalog>(previousRoot, "catalog.jox");
  const result = await buildNewsDelivery({
    workspaceRoot,
    deliveryRoot,
    generatedAt,
    sources,
    process: processResult,
    ...(previousTimelineIndex ? { previousTimelineIndex } : {}),
    ...(previousTimelineDays.size ? { previousTimelineDays } : {}),
    ...(previousSourceIndexes.size ? { previousSourceIndexes } : {}),
    ...(previousCatalog ? { previousCatalog } : {}),
  });
  return { deliveryRoot, ...result };
}

async function main(): Promise<void> {
  process.stdout.write(`${JSON.stringify(await runDelivery(parseArgs(process.argv.slice(2))), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
