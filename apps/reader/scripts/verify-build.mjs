#!/usr/bin/env node

import { readFile, readdir, stat } from "node:fs/promises";

const distDir = new URL("../dist/", import.meta.url);
const assetsDir = new URL("assets/", distDir);

async function fail(message) {
  console.error(`Reader build verification failed: ${message}`);
  process.exitCode = 1;
}

try {
  const assetNames = await readdir(assetsDir);
  const workers = assetNames.filter((name) => name.startsWith("pdf.worker-"));

  if (workers.length !== 1) {
    await fail(`expected exactly one PDF worker, found ${workers.length}: ${workers.join(", ") || "none"}`);
  } else {
    const worker = workers[0];
    if (!worker.endsWith(".js")) {
      await fail(`PDF worker must use .js so object storage serves a JavaScript MIME type: ${worker}`);
    }

    const workerStats = await stat(new URL(worker, assetsDir));
    if (workerStats.size < 100_000) {
      await fail(`PDF worker is unexpectedly small (${workerStats.size} bytes): ${worker}`);
    }

    const indexHtml = await readFile(new URL("index.html", distDir), "utf8");
    const entryMatch = /assets\/(index-[^"']+\.js)/.exec(indexHtml);
    if (!entryMatch?.[1]) {
      await fail("index.html does not reference a hashed JavaScript entry");
    } else {
      const entry = await readFile(new URL(entryMatch[1], assetsDir), "utf8");
      if (!entry.includes(worker)) {
        await fail(`JavaScript entry does not reference the emitted PDF worker: ${worker}`);
      }
      if (/pdf\.worker-[^"']+\.mjs/.test(entry)) {
        await fail("JavaScript entry still references an .mjs PDF worker");
      }
    }

    if (!process.exitCode) {
      console.log(`Reader build verified: ${worker} (${workerStats.size} bytes)`);
    }
  }
} catch (error) {
  await fail(error instanceof Error ? error.message : String(error));
}
