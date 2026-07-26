#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const DEFAULT_INTERVAL_SECONDS = 10;
const DEFAULT_TIMEOUT_SECONDS = 180;

function usage() {
  console.log(`Usage:
  pnpm finalize:reader-pdf -- --zone-id zone-xxx <url> [url...]

Options:
  --interval <seconds>   Verification polling interval. Default: ${DEFAULT_INTERVAL_SECONDS}
  --timeout <seconds>    Verification timeout. Default: ${DEFAULT_TIMEOUT_SECONDS}
  --no-purge             Skip EdgeOne purge and only poll verifier.
  --zone-id <zone-id>    EdgeOne zone id. Defaults to EDGEONE_ZONE_ID.

This runs EdgeOne URL purge, then polls the Reader PDF verifier until all URLs
report PASS state=protected range=206 direct=fails.
`);
}

function parseArgs(argv) {
  const urls = [];
  let interval = DEFAULT_INTERVAL_SECONDS;
  let purge = true;
  let timeout = DEFAULT_TIMEOUT_SECONDS;
  let zoneId = process.env.EDGEONE_ZONE_ID ?? null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--no-purge") {
      purge = false;
      continue;
    }
    if (arg === "--interval") {
      interval = Number(argv[++i]);
      continue;
    }
    if (arg === "--timeout") {
      timeout = Number(argv[++i]);
      continue;
    }
    if (arg === "--zone-id") {
      zoneId = argv[++i];
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    urls.push(arg);
  }

  if (urls.length === 0) throw new Error("At least one URL is required");
  if (purge && !zoneId) throw new Error("--zone-id or EDGEONE_ZONE_ID is required unless --no-purge is used");
  if (!Number.isFinite(interval) || interval <= 0) throw new Error("--interval must be a positive number");
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("--timeout must be a positive number");
  return { interval, purge, timeout, urls, zoneId };
}

function run(command, args) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  return spawnSync(command, args, { encoding: "utf8", stdio: "inherit" });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function main() {
  const { interval, purge, timeout, urls, zoneId } = parseArgs(process.argv.slice(2));

  if (purge) {
    const purgeResult = run("node", [
      "tooling/reader-pdf/purge-cache.mjs",
      "--zone-id",
      zoneId,
      ...urls,
    ]);
    if (purgeResult.status !== 0) {
      process.exitCode = purgeResult.status ?? 1;
      return;
    }
  }

  const deadline = Date.now() + timeout * 1000;
  let attempt = 1;
  while (Date.now() <= deadline) {
    console.log(`Verify attempt ${attempt}`);
    const verifyResult = run("node", ["tooling/reader-pdf/verify.mjs", ...urls]);
    if (verifyResult.status === 0) return;
    attempt += 1;
    if (Date.now() + interval * 1000 > deadline) break;
    await sleep(interval * 1000);
  }

  console.error(`Timed out after ${timeout}s waiting for protected public URLs`);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
