#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import path from "node:path";
import { buildContentPipeline } from "./builder";

interface Arguments {
  input: string[];
  output?: string;
  fetchAssets: boolean;
  allowPartial: boolean;
}

function argumentsFrom(argv: string[]): Arguments {
  const result: Arguments = { input: [], fetchAssets: true, allowPartial: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === "--input" || value === "-i") result.input.push(path.resolve(argv[++index]!));
    else if (value === "--input-dir") result.input.push(path.resolve(argv[++index]!));
    else if (value === "--output" || value === "-o") result.output = path.resolve(argv[++index]!);
    else if (value === "--no-assets") result.fetchAssets = false;
    else if (value === "--allow-partial") result.allowPartial = true;
    else throw new Error(`未知参数：${value}`);
  }
  return result;
}

const args = argumentsFrom(process.argv.slice(2));
if (!args.output || args.input.length === 0) {
  console.error("Usage: content-pipeline --input <file|directory>... --output <empty-directory> [--no-assets] [--allow-partial]");
  process.exit(2);
}
const inputPaths: string[] = [];
for (const input of args.input) {
  const entries = await readdir(input, { withFileTypes: true }).catch(() => undefined);
  if (!entries) inputPaths.push(input);
  else {
    inputPaths.push(...entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
      .map((entry) => path.join(input, entry.name)));
  }
}
try {
  const report = await buildContentPipeline({
    inputPaths,
    outputDirectory: args.output,
    fetchAssets: args.fetchAssets,
    allowPartial: args.allowPartial,
    onProgress: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
  });
  if (!args.allowPartial && report.diagnostics.some((entry) => entry.level === "error")) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${JSON.stringify({ phase: "failed", error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
