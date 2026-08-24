import { readFile } from "node:fs/promises";
import path from "node:path";
import type { JojoCatalog, NewsPublisherIndex } from "@jojo/content";
import { parseArgs, requiredArg } from "./args.js";
import { loadSources } from "./config.js";
import { buildNewsDelivery, readJoxJson, type RawRunManifest } from "./delivery-writer.js";

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
  const sources = await loadSources(configPath);
  const previousDelivery = args.get("previous-delivery") ? path.resolve(args.get("previous-delivery")!) : undefined;
  const previousCatalog = await optionalJox<JojoCatalog>(
    previousDelivery ? path.join(previousDelivery, "catalog.jox") : undefined,
    "catalog.jox",
  );
  const previousIndexes = new Map<string, NewsPublisherIndex>();
  if (previousDelivery) {
    await Promise.all(sources.map(async (source) => {
      const objectKey = `content/newspapers/${source.id}/index.jox`;
      const index = await optionalJox<NewsPublisherIndex>(path.join(previousDelivery, ...objectKey.split("/")), objectKey);
      if (index) previousIndexes.set(source.id, index);
    }));
  }
  const result = await buildNewsDelivery({
    workspaceRoot,
    deliveryRoot,
    run,
    sources,
    windowHours,
    ...(previousIndexes.size ? { previousIndexes } : {}),
    ...(previousCatalog ? { previousCatalog } : {}),
  });
  process.stdout.write(`${JSON.stringify({
    deliveryRoot,
    articles: result.articles,
    sources: result.sources,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
