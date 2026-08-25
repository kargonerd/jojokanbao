import { gunzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, requiredArg } from "./args.js";
import { writeCanonicalSource } from "./canonical-writer.js";
import { loadSources } from "./config.js";
import { processSourceCandidate } from "./sources/registry.js";
import type { Candidate, SourceCaptureManifest } from "./types.js";

interface RawRunManifest {
  runId: string;
  sources: Array<{ sourceId: string; status: "ok" | "empty" | "error"; output?: { manifest?: string } }>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const output = path.resolve(requiredArg(args, "output"));
  const runManifestPath = path.resolve(requiredArg(args, "run-manifest"));
  const configPath = path.resolve(requiredArg(args, "config"));
  const rawRevision = args.get("raw-revision") ?? "local";
  const sources = new Map((await loadSources(configPath)).map((source) => [source.id, source]));
  const run = JSON.parse(await readFile(runManifestPath, "utf8")) as RawRunManifest;
  const results: Array<{ sourceId: string; dates: string[]; articles: number; skippedMetadata: number }> = [];
  for (const row of run.sources) {
    if (row.status !== "ok" || !row.output?.manifest) continue;
    const source = sources.get(row.sourceId);
    if (!source) continue;
    const manifestPath = path.join(output, ...row.output.manifest.split("/"));
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as SourceCaptureManifest;
    const candidatesPath = path.join(path.dirname(manifestPath), "candidates.jsonl.gz");
    const candidates = gunzipSync(await readFile(candidatesPath)).toString("utf8")
      .split(/\r?\n/).filter(Boolean)
      .map((line) => processSourceCandidate(source.id, JSON.parse(line) as Candidate));
    results.push(await writeCanonicalSource(output, source, manifest, row.output.manifest, candidates, rawRevision));
  }
  const reportPath = path.join(output, "canonical", "news", "runs", `${run.runId}.json`);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify({
    formatVersion: "jojo-times-canonical-run/1",
    runId: run.runId,
    rawRevision,
    processedAt: new Date().toISOString(),
    sources: results,
  }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ report: reportPath, sources: results }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
