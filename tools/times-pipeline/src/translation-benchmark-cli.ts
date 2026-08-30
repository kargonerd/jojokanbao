import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "./args.js";
import {
  collectBenchmarkSample,
  judgeHardCases,
  loadEnvValue,
  translateSample,
  writeBenchmarkReport,
  type BenchmarkArticle,
} from "./translation/benchmark.js";

async function existingSample(file: string): Promise<BenchmarkArticle[] | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as BenchmarkArticle[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Expected a positive integer, received ${value}`);
  return parsed;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sampleSize = positiveInteger(args.get("sample"), 100);
  const judgeCount = positiveInteger(args.get("judge"), 20);
  const outputRoot = path.resolve(args.get("output") ?? path.join(".review", `translation-benchmark-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`));
  const envFile = path.resolve(args.get("env") ?? ".env.local");
  const apiKey = process.env.GEMINI_API_KEY || await loadEnvValue(envFile, "GEMINI_API_KEY");
  if (!apiKey) throw new Error(`GEMINI_API_KEY is missing from the environment and ${envFile}`);
  await mkdir(outputRoot, { recursive: true });
  const sampleFile = path.join(outputRoot, "sample.json");
  let articles = await existingSample(sampleFile);
  if (!articles) {
    articles = await collectBenchmarkSample({
      cdnBase: args.get("cdn") ?? "https://blacknews.jojokanbao.cn/",
      sampleSize,
      onProgress: (message) => process.stderr.write(`${message}\n`),
    });
    await writeFile(sampleFile, `${JSON.stringify(articles, null, 2)}\n`, "utf8");
  }
  const models = (args.get("models") ?? "gemma-4-31b-it,gemma-4-26b-a4b-it").split(",").map((model) => model.trim()).filter(Boolean);
  if (models.length !== 2) throw new Error("--models must contain exactly two comma-separated model ids");
  const translated = await Promise.all(models.map(async (model) => ({
    model,
    results: await translateSample({
      apiKey,
      model,
      articles,
      outputFile: path.join(outputRoot, `${model}.jsonl`),
      onProgress: (message) => process.stderr.write(`${message}\n`),
    }),
  })));
  const judges = await judgeHardCases({
    apiKey,
    judgeModel: args.get("judge-model") ?? "gemini-3.7-flash",
    articles,
    leftModel: translated[0]!.model,
    left: translated[0]!.results,
    rightModel: translated[1]!.model,
    right: translated[1]!.results,
    count: judgeCount,
    outputFile: path.join(outputRoot, "judges.jsonl"),
    onProgress: (message) => process.stderr.write(`${message}\n`),
  });
  const report = await writeBenchmarkReport({ outputRoot, articles, models: translated, judges });
  process.stdout.write(`${JSON.stringify({ outputRoot, sample: articles.length, models, judges: judges.length, ...report }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
