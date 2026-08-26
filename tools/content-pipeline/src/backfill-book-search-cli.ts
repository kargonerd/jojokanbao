import path from "node:path";
import { buildBookSearchBackfill } from "./backfill-book-search";

const args = process.argv.slice(2);
const values = (name: string): string[] => args.flatMap((value, index) => (
  value === name && args[index + 1] ? [args[index + 1]!] : []
));
const value = (name: string): string | undefined => values(name).at(-1);
const outputDirectory = value("--output");
if (!outputDirectory) {
  throw new Error("Usage: backfill-book-search --output <directory> [--cdn-base <url>] [--dataset-id <id>] [--force] [--resume]");
}

const report = await buildBookSearchBackfill({
  contentCdnBase: value("--cdn-base") || "https://blacknews.jojokanbao.cn/",
  outputDirectory: path.resolve(outputDirectory),
  datasetIds: values("--dataset-id"),
  force: args.includes("--force"),
  resume: args.includes("--resume"),
  onProgress: (message) => process.stderr.write(`${message}\n`),
});
process.stdout.write(`${JSON.stringify({
  datasets: report.selectedDatasetCount,
  items: report.selectedItemCount,
  existing: report.skippedExistingCount,
  backfilled: report.backfilledItems.length,
  searchBytes: report.backfilledItems.reduce((total, item) => total + item.searchSize, 0),
}, null, 2)}\n`);
