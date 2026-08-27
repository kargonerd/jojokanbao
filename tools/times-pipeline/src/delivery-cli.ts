import { readFile } from "node:fs/promises";
import path from "node:path";
import type { JojoCatalog, TimesSourceIndex, TimesTimelineDay, TimesTimelineIndex } from "@jojo/content";
import type { CanonicalWriteResult } from "./process/canonical-writer.js";
import { parseArgs, requiredArg } from "./args.js";
import { loadSources } from "./config.js";
import { buildNewsDelivery, readJoxJson } from "./delivery-writer.js";

interface ProcessResult {
  report: string;
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const workspaceRoot = path.resolve(requiredArg(args, "output"));
  const configPath = path.resolve(requiredArg(args, "config"));
  const processResult = JSON.parse(await readFile(path.resolve(requiredArg(args, "process-result")), "utf8")) as ProcessResult;
  const deliveryRoot = path.resolve(args.get("delivery-output") ?? path.join(workspaceRoot, "delivery"));
  const previousRoot = args.get("previous-delivery");
  const sources = await loadSources(configPath);
  const previousTimelineIndex = await optionalJox<TimesTimelineIndex>(previousRoot, "content/timeline/index.jox");
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
    generatedAt: new Date().toISOString(),
    sources,
    process: processResult,
    ...(previousTimelineIndex ? { previousTimelineIndex } : {}),
    ...(previousTimelineDays.size ? { previousTimelineDays } : {}),
    ...(previousSourceIndexes.size ? { previousSourceIndexes } : {}),
    ...(previousCatalog ? { previousCatalog } : {}),
  });
  process.stdout.write(`${JSON.stringify({ deliveryRoot, ...result }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
