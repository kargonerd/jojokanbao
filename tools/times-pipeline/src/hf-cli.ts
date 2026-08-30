import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, requiredArg } from "./args.js";
import { loadSources } from "./config.js";
import {
  collectFolderFiles,
  type HfConflictStrategy,
  HfTimesDataset,
  readHfFileSetManifest,
} from "./hf.js";

interface ProcessResult {
  report: string;
  sources: Array<{ sourceId: string; files: string[] }>;
}

interface RawRun {
  runId: string;
}

function token(args: Map<string, string>): string {
  const environmentName = args.get("token-env") ?? "HF_TOKEN";
  const value = process.env[environmentName]?.trim();
  if (!value) throw new Error(`${environmentName} is not configured`);
  return value;
}

async function canonicalFiles(output: string, processResultFile: string): Promise<Array<{ local: string; objectName: string }>> {
  const result = JSON.parse(await readFile(path.resolve(processResultFile), "utf8")) as ProcessResult;
  const files = new Map<string, { local: string; objectName: string }>();
  for (const source of result.sources) {
    for (const objectName of source.files) {
      files.set(objectName, { local: path.join(path.resolve(output), ...objectName.split("/")), objectName });
    }
  }
  const report = path.resolve(result.report);
  const reportRelative = path.relative(path.resolve(output), report).split(path.sep).join("/");
  if (reportRelative.startsWith("../") || reportRelative === "..") throw new Error("Canonical report is outside the output root");
  files.set(reportRelative, { local: report, objectName: reportRelative });
  return [...files.values()];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const action = requiredArg(args, "action");
  const output = path.resolve(requiredArg(args, "output"));
  const dataset = new HfTimesDataset(requiredArg(args, "repo"), output, token(args));
  if (action === "restore-state") {
    const sources = await loadSources(path.resolve(requiredArg(args, "config")));
    process.stdout.write(`${JSON.stringify(await dataset.restoreState(sources.map((source) => source.id)), null, 2)}\n`);
    return;
  }
  if (action === "download-snapshot") {
    process.stdout.write(`${JSON.stringify(await dataset.downloadSnapshot(args.get("github-run-id")), null, 2)}\n`);
    return;
  }
  if (action === "download-files") {
    const manifest = await readHfFileSetManifest(path.resolve(requiredArg(args, "file-manifest")));
    process.stdout.write(`${JSON.stringify(await dataset.downloadFileSet(manifest, args.get("revision")), null, 2)}\n`);
    return;
  }
  if (action === "upload-files") {
    const manifest = await readHfFileSetManifest(path.resolve(requiredArg(args, "file-manifest")));
    const conflictStrategy = args.get("conflict-strategy") ?? "fail";
    if (conflictStrategy !== "fail" && conflictStrategy !== "retry-disjoint") {
      throw new Error(`Unsupported HF conflict strategy: ${conflictStrategy}`);
    }
    const result = await dataset.uploadFileSet(
      manifest,
      requiredArg(args, "title"),
      conflictStrategy as HfConflictStrategy,
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (action === "upload-raw") {
    const runId = requiredArg(args, "run-id");
    const files = await collectFolderFiles(path.join(output, "raw"), "raw");
    const revision = await dataset.uploadLocalFiles(files, `times raw ${runId}`);
    process.stdout.write(`${JSON.stringify({ revision, files: files.length }, null, 2)}\n`);
    return;
  }
  if (action === "upload-canonical") {
    const run = JSON.parse(await readFile(path.resolve(requiredArg(args, "run-manifest")), "utf8")) as RawRun;
    const files = await canonicalFiles(output, requiredArg(args, "process-result"));
    const revision = await dataset.uploadLocalFiles(files, `times canonical ${run.runId}`);
    process.stdout.write(`${JSON.stringify({ revision, files: files.length }, null, 2)}\n`);
    return;
  }
  throw new Error(`Unsupported HF action: ${action}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
