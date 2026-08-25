import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./args.js";
import { loadSources } from "./config.js";

interface WorkerResult {
  sourceId: string;
  status: "ok" | "empty" | "error";
  exitCode: number;
  output?: unknown;
  error?: string;
}

function runId(date: Date): string {
  return date.toISOString().replaceAll(/[-:.]/g, "").replace("Z", "Z") + `-${process.env.GITHUB_RUN_ID ?? process.pid}`;
}

async function runWorker(worker: string, args: string[], sourceId: string): Promise<WorkerResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [worker, ...args], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("close", (code) => {
      const lastLine = stdout.trim().split(/\r?\n/).at(-1);
      let output: unknown;
      try { output = lastLine ? JSON.parse(lastLine) : undefined; } catch { output = undefined; }
      if (code !== 0 && stderr) process.stderr.write(`[${sourceId}] ${stderr.trim()}\n`);
      const reportedStatus = output && typeof output === "object" && (output as { status?: unknown }).status === "empty"
        ? "empty"
        : "ok";
      resolve({
        sourceId,
        status: code === 0 ? reportedStatus : "error",
        exitCode: code ?? 1,
        ...(output ? { output } : {}),
        ...(code !== 0 && stderr.trim() ? { error: stderr.trim().slice(0, 2_000) } : {}),
      });
    });
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const config = path.resolve(args.get("config") ?? path.join(packageRoot, "sources.v2.json"));
  const output = path.resolve(args.get("output") ?? path.join(os.tmpdir(), "jojo-times-v2"));
  const concurrency = Number(args.get("workers") ?? "3");
  const sinceHours = args.get("since-hours") ?? "24";
  const windowHours = Number(sinceHours);
  if (!Number.isFinite(windowHours) || windowHours <= 0) throw new Error("--since-hours must be positive");
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("--workers must be a positive integer");
  const requested = new Set((args.get("sources") ?? "").split(",").map((value) => value.trim()).filter(Boolean));
  const sources = (await loadSources(config)).filter((source) => requested.size === 0 || requested.has(source.id));
  const serialIds = new Set((args.get("serial-sources") ?? "").split(",").map((value) => value.trim()).filter(Boolean));
  if (sources.length === 0) throw new Error("No selected source is enabled");
  await mkdir(output, { recursive: true });
  const started = new Date();
  const id = runId(started);
  const worker = fileURLToPath(new URL("./source-worker.js", import.meta.url));
  const results: WorkerResult[] = [];
  const parallelSources = sources.filter((source) => !serialIds.has(source.id));
  const serialSources = sources.filter((source) => serialIds.has(source.id));
  let cursor = 0;
  async function consume(): Promise<void> {
    while (cursor < parallelSources.length) {
      const source = parallelSources[cursor++];
      if (!source) return;
      results.push(await runWorker(worker, [
        "--config", config,
        "--output", output,
        "--source", source.id,
        "--run-id", id,
        "--started-at", started.toISOString(),
        "--since-hours", sinceHours,
      ], source.id));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, parallelSources.length) }, consume));
  for (const source of serialSources) {
    results.push(await runWorker(worker, [
      "--config", config,
      "--output", output,
      "--source", source.id,
      "--run-id", id,
      "--started-at", started.toISOString(),
      "--since-hours", sinceHours,
    ], source.id));
  }
  const date = started.toISOString().slice(0, 10).replaceAll("-", "/");
  const runManifest = path.join(output, "raw", "news", "runs", ...date.split("/"), `${id}.json`);
  await mkdir(path.dirname(runManifest), { recursive: true });
  await writeFile(runManifest, `${JSON.stringify({
    formatVersion: "jojo-times-raw-run/1",
    runId: id,
    startedAt: started.toISOString(),
    completedAt: new Date().toISOString(),
    windowHours,
    sourceCount: sources.length,
    succeeded: results.filter((result) => result.status === "ok").length,
    degraded: results.filter((result) => result.status === "empty").length,
    failed: results.filter((result) => result.status === "error").length,
    sources: results.sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
    complete: true,
  }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ runId: id, runManifest, results }, null, 2)}\n`);
  if (results.some((result) => result.status === "error")) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
