import path from "node:path";
import { parseArgs, requiredArg } from "./args.js";
import { loadSources } from "./config.js";
import { discoverSource } from "./discovery/multi.js";
import { RecordingFetch } from "./recording-fetch.js";
import { sourceRunRoot, writeSourceCapture } from "./raw-writer.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const configPath = path.resolve(requiredArg(args, "config"));
  const output = path.resolve(requiredArg(args, "output"));
  const sourceId = requiredArg(args, "source");
  const runId = requiredArg(args, "run-id");
  const startedAt = requiredArg(args, "started-at");
  const sinceHours = Number(args.get("since-hours") ?? "24");
  if (!Number.isFinite(sinceHours) || sinceHours <= 0) throw new Error("--since-hours must be positive");
  const source = (await loadSources(configPath)).find((candidate) => candidate.id === sourceId);
  if (!source) throw new Error(`Unknown or disabled source: ${sourceId}`);
  const runRoot = sourceRunRoot(output, source.id, runId, startedAt);
  const recorder = new RecordingFetch(runRoot);
  const restoreFetch = recorder.install();
  try {
    const fetchedAt = new Date().toISOString();
    const cutoff = new Date(startedAt).valueOf() - sinceHours * 3_600_000;
    const result = await discoverSource(source, fetchedAt, cutoff);
    result.candidates = result.candidates.filter((candidate) => new Date(candidate.publishedAt).valueOf() >= cutoff);
    const networkFile = await recorder.flush();
    const manifest = await writeSourceCapture(runRoot, runId, startedAt, result, networkFile, recorder.exchanges.length);
    const status = manifest.healthStatus === "empty" ? "empty" : "ok";
    process.stdout.write(`${JSON.stringify({
      sourceId,
      status,
      manifest: path.relative(output, path.join(runRoot, "manifest.json")).replaceAll(path.sep, "/"),
      candidates: manifest.candidateCount,
    })}\n`);
  } finally {
    restoreFetch();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
