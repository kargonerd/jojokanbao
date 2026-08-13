#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { buildContentPipeline } from "./builder";

interface Arguments {
  input: string[];
  output?: string;
  assetCache?: string;
  fetchAssets: boolean;
  allowPartial: boolean;
  publicationStatus: "draft" | "published";
  access: "public" | "authenticated";
}

function argumentsFrom(argv: string[]): Arguments {
  const result: Arguments = { input: [], fetchAssets: true, allowPartial: false, publicationStatus: "draft", access: "public" };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === "--input" || value === "-i") result.input.push(path.resolve(argv[++index]!));
    else if (value === "--input-dir") result.input.push(path.resolve(argv[++index]!));
    else if (value === "--output" || value === "-o") result.output = path.resolve(argv[++index]!);
    else if (value === "--asset-cache") result.assetCache = path.resolve(argv[++index]!);
    else if (value === "--no-assets") result.fetchAssets = false;
    else if (value === "--allow-partial") result.allowPartial = true;
    else if (value === "--published") result.publicationStatus = "published";
    else if (value === "--draft") result.publicationStatus = "draft";
    else if (value === "--authenticated") result.access = "authenticated";
    else if (value === "--public") result.access = "public";
    else throw new Error(`未知参数：${value}`);
  }
  return result;
}

const args = argumentsFrom(process.argv.slice(2));
if (!args.output || args.input.length === 0) {
  console.error("Usage: content-pipeline --input <json|epub|azw|mobi|prc|directory>... --output <empty-directory> [--published|--draft] [--public|--authenticated] [--asset-cache <canonical-directory>] [--no-assets] [--allow-partial]");
  process.exit(2);
}
const inputPaths: string[] = [];
async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(target));
    else if (entry.isFile() && /\.(?:json|epub|azw|mobi|prc)$/i.test(entry.name)) files.push(target);
  }
  return files;
}

async function filesNamed(directory: string, name: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesNamed(target, name));
    else if (entry.isFile() && entry.name === name) files.push(target);
  }
  return files;
}

async function cachedAssetFetch(cacheDirectory: string): Promise<typeof fetch> {
  const assets = new Map<string, { file: string; mediaType: string }>();
  for (const itemFile of await filesNamed(cacheDirectory, "item.json.gz")) {
    const item = JSON.parse(gunzipSync(await readFile(itemFile)).toString("utf8")) as {
      assets?: Array<{ sourceUrl?: string; path?: string; mediaType?: string }>;
    };
    const datasetDirectory = path.dirname(path.dirname(path.dirname(itemFile)));
    for (const asset of item.assets ?? []) {
      if (asset.sourceUrl && asset.path) {
        assets.set(asset.sourceUrl, {
          file: path.join(datasetDirectory, ...asset.path.split("/")),
          mediaType: asset.mediaType ?? "application/octet-stream",
        });
      }
    }
  }
  process.stderr.write(`Asset cache: ${assets.size} source URLs\n`);
  const fallback = fetch;
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const cached = assets.get(url);
    if (!cached) return fallback(input, init);
    const bytes = await readFile(cached.file);
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-length": String(bytes.length),
        "content-type": cached.mediaType,
      },
    });
  };
}

for (const input of args.input) {
  const entries = await readdir(input, { withFileTypes: true }).catch(() => undefined);
  if (!entries) inputPaths.push(input);
  else inputPaths.push(...await sourceFiles(input));
}
try {
  const fetchFn = args.assetCache ? await cachedAssetFetch(args.assetCache) : undefined;
  const report = await buildContentPipeline({
    inputPaths,
    outputDirectory: args.output,
    fetchAssets: args.fetchAssets,
    ...(fetchFn ? { fetchFn } : {}),
    allowPartial: args.allowPartial,
    publicationStatus: args.publicationStatus,
    access: args.access,
    onProgress: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
  });
  if (!args.allowPartial && report.diagnostics.some((entry) => entry.level === "error")) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${JSON.stringify({ phase: "failed", error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
