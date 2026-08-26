import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, requiredArg } from "./args.js";
import { collectFolderFiles, HfTimesDataset } from "./hf.js";

interface ProcessResult {
  report: string;
  sources: Array<{ sourceId: string; dates: string[] }>;
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
  const canonical = path.join(path.resolve(output), "canonical");
  const files: Array<{ local: string; objectName: string }> = [];
  for (const source of result.sources) {
    const relative = [path.posix.join("news", source.sourceId, "dataset.json")];
    relative.push(...source.dates.map((date) => (
      path.posix.join("news", source.sourceId, "articles", date.slice(0, 4), date.slice(5, 7), `${date}.jsonl.gz`)
    )));
    for (const objectName of relative) {
      files.push({ local: path.join(canonical, ...objectName.split("/")), objectName: path.posix.join("canonical", objectName) });
    }
  }
  const report = path.resolve(result.report);
  const reportRelative = path.relative(canonical, report).split(path.sep).join("/");
  if (reportRelative.startsWith("../") || reportRelative === "..") throw new Error("Canonical report is outside the output root");
  files.push({ local: report, objectName: path.posix.join("canonical", reportRelative) });
  return files;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const action = requiredArg(args, "action");
  const output = path.resolve(requiredArg(args, "output"));
  const dataset = new HfTimesDataset(requiredArg(args, "repo"), output, token(args));
  if (action === "restore-state") {
    process.stdout.write(`${JSON.stringify(await dataset.restoreState(), null, 2)}\n`);
    return;
  }
  if (action === "download-snapshot") {
    process.stdout.write(`${JSON.stringify(await dataset.downloadLatestSnapshot(), null, 2)}\n`);
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
