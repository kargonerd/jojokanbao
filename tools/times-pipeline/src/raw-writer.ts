import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DiscoveryResult, SourceCaptureManifest } from "./types.js";

async function descriptor(runRoot: string, target: string): Promise<{ path: string; size: number; sha256: string }> {
  const body = await readFile(target);
  return {
    path: path.relative(runRoot, target).replaceAll(path.sep, "/"),
    size: (await stat(target)).size,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

async function filesBelow(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

export function sourceRunRoot(output: string, sourceId: string, runId: string, startedAt: string): string {
  const date = new Date(startedAt);
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return path.join(output, "raw", "news", sourceId, year, month, day, runId);
}

export async function writeSourceCapture(
  runRoot: string,
  runId: string,
  startedAt: string,
  result: DiscoveryResult,
  networkFile: string,
  networkExchangeCount: number,
): Promise<SourceCaptureManifest> {
  await mkdir(runRoot, { recursive: true });
  const discoveryFile = path.join(runRoot, "discovery.json.gz");
  const candidatesFile = path.join(runRoot, "candidates.jsonl.gz");
  const discovery = {
    formatVersion: "jojo-times-discovery/1",
    sourceId: result.source.id,
    transport: result.transport,
    fetchedAt: result.fetchedAt,
    ...(result.version ? { version: result.version } : {}),
    data: result.upstream,
  };
  await writeFile(discoveryFile, gzipSync(`${JSON.stringify(discovery)}\n`, { level: 9 }));
  await writeFile(candidatesFile, gzipSync(
    result.candidates.map((candidate) => JSON.stringify(candidate)).join("\n") + (result.candidates.length ? "\n" : ""),
    { level: 9 },
  ));
  const bodyFiles = await filesBelow(path.join(runRoot, "network", "bodies"));
  const objects = await Promise.all([discoveryFile, candidatesFile, networkFile, ...bodyFiles]
    .map((target) => descriptor(runRoot, target)));
  const manifest: SourceCaptureManifest = {
    formatVersion: "jojo-times-raw-source-run/1",
    runId,
    sourceId: result.source.id,
    sourceName: result.source.name,
    startedAt,
    completedAt: new Date().toISOString(),
    discovery: result.source.discovery,
    candidateCount: result.candidates.length,
    fullCount: result.candidates.filter((candidate) => candidate.contentStatus === "full").length,
    summaryCount: result.candidates.filter((candidate) => candidate.contentStatus === "summary").length,
    metadataCount: result.candidates.filter((candidate) => candidate.contentStatus === "metadata").length,
    networkExchangeCount,
    objects,
    archiveStatus: "recorded-http",
    healthStatus: result.candidates.length >= result.source.health.minimumCandidates ? "healthy" : "empty",
    complete: true,
  };
  await writeFile(path.join(runRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
