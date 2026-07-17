#!/usr/bin/env node

import { readFile, readdir, stat } from "node:fs/promises";

const distDir = new URL("../dist/", import.meta.url);
const assetsDir = new URL("assets/", distDir);

async function fail(message) {
  console.error(`Reader build verification failed: ${message}`);
  process.exitCode = 1;
}

async function fileCount(directory) {
  return (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile()).length;
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

      const pdfjsAssets = [
        { folder: "cmaps", minimum: 100 },
        { folder: "wasm", minimum: 10 },
        { folder: "standard_fonts", minimum: 10 },
      ];
      for (const { folder, minimum } of pdfjsAssets) {
        const count = await fileCount(new URL(`pdfjs/${folder}/`, assetsDir));
        if (count < minimum) {
          await fail(`expected at least ${minimum} local PDF.js ${folder} files, found ${count}`);
        }
        if (!entry.includes(`/assets/pdfjs/${folder}/`)) {
          await fail(`JavaScript entry does not reference local PDF.js ${folder}`);
        }
      }
    }

    if (!process.exitCode) {
      console.log(`Reader build verified: ${worker} (${workerStats.size} bytes)`);
    }
  }
} catch (error) {
  await fail(error instanceof Error ? error.message : String(error));
}
