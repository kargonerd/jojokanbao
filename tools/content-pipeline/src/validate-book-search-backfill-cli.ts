import path from "node:path";
import { validateBookSearchBackfill } from "./validate-book-search-backfill";

const args = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const index = args.lastIndexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const outputDirectory = value("--output");
if (!outputDirectory) {
  throw new Error("Usage: validate-book-search-backfill --output <directory> [--cdn-base <url>] [--local-only] [--verify-published]");
}

const result = await validateBookSearchBackfill({
  outputDirectory: path.resolve(outputDirectory),
  contentCdnBase: value("--cdn-base"),
  verifySource: !args.includes("--local-only"),
  verifyPublished: args.includes("--verify-published"),
  onProgress: (message) => process.stderr.write(`${message}\n`),
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.errors.length) process.exitCode = 1;
