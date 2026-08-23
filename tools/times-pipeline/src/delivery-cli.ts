import { readFile } from "node:fs/promises";
import path from "node:path";
import type { JojoCatalog, TimesDeliveryIndex } from "@jojo/content";
import { parseArgs, requiredArg } from "./args.js";
import { loadSources } from "./config.js";
import { buildTimesDelivery, readJoxJson, type RawRunManifest } from "./delivery-writer.js";

async function optionalJox<T>(target: string | undefined, objectKey: string): Promise<T | undefined> {
  if (!target) return undefined;
  try {
    return readJoxJson<T>(new Uint8Array(await readFile(path.resolve(target))), objectKey);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const workspaceRoot = path.resolve(requiredArg(args, "output"));
  const runManifestPath = path.resolve(requiredArg(args, "run-manifest"));
  const configPath = path.resolve(requiredArg(args, "config"));
  const deliveryRoot = path.resolve(args.get("delivery-output") ?? path.join(workspaceRoot, "delivery"));
  const run = JSON.parse(await readFile(runManifestPath, "utf8")) as RawRunManifest;
  const windowHours = Number(args.get("window-hours") ?? run.windowHours ?? 24);
  if (!Number.isFinite(windowHours) || windowHours <= 0) throw new Error("--window-hours must be positive");
  const previousIndex = await optionalJox<TimesDeliveryIndex>(args.get("previous-index"), "content/newspapers/times/index.jox");
  const previousCatalog = await optionalJox<JojoCatalog>(args.get("previous-catalog"), "catalog.jox");
  const result = await buildTimesDelivery({
    workspaceRoot,
    deliveryRoot,
    run,
    sources: await loadSources(configPath),
    windowHours,
    ...(previousIndex ? { previousIndex } : {}),
    ...(previousCatalog ? { previousCatalog } : {}),
  });
  process.stdout.write(`${JSON.stringify({
    deliveryRoot,
    indexObject: result.indexObject,
    articles: result.articles,
    sourceHealth: result.sourceHealth,
    unavailableCaseCount: result.unavailableCases.length,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
