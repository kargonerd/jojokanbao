#!/usr/bin/env node

import { readFile, readdir, stat } from "node:fs/promises";

const distDir = new URL("../dist/", import.meta.url);
const assetsDir = new URL("assets/", distDir);
const maximumEntryBytes = 450_000;

async function fail(message) {
  console.error(`Web build verification failed: ${message}`);
  process.exitCode = 1;
}

async function fileCount(directory) {
  return (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile()).length;
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

try {
  for (const legacyFolder of ["cmaps", "pdfjs"]) {
    if (await pathExists(new URL(`${legacyFolder}/`, distDir))) {
      await fail(`legacy /${legacyFolder} assets must not be included in the Web build`);
    }
  }

  const assetNames = await readdir(assetsDir);
  const workers = assetNames.filter((name) => name.startsWith("pdf.worker-"));
  const stylesheets = assetNames.filter((name) => name.endsWith(".css"));
  const javascriptFiles = assetNames.filter((name) => name.endsWith(".js"));
  const indexHtml = await readFile(new URL("index.html", distDir), "utf8");
  const sitemap = await readFile(new URL("sitemap.xml", distDir), "utf8");
  const emittedReferences = [
    indexHtml,
    ...await Promise.all(
      javascriptFiles.map((name) => readFile(new URL(name, assetsDir), "utf8")),
    ),
  ].join("\n");

  for (const publication of ["rmrb", "ckxx", "hq", "rmhb", "sjzs"]) {
    if (!sitemap.includes(`https://reader.jojokanbao.cn/archive/${publication}`)) {
      await fail(`sitemap is missing the canonical Archive path for ${publication}`);
    }
  }

  for (const stylesheet of stylesheets) {
    const css = await readFile(new URL(stylesheet, assetsDir), "utf8");
    if (/@layer(?:\s+[-\w.]+)?\s*\{/.test(css)) {
      await fail(`legacy browser compatibility requires flattened cascade layers: ${stylesheet}`);
    }
    if (!emittedReferences.includes(`assets/${stylesheet}`)) {
      await fail(`the emitted HTML and JavaScript do not reference the stylesheet: ${stylesheet}`);
    }
  }

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

    const workerSource = await readFile(new URL(worker, assetsDir), "utf8");
    if (!workerSource.includes("toHex") || !workerSource.includes("ffffffffffffffff")) {
      await fail("PDF worker is missing the legacy Uint8Array.toHex compatibility code");
    }

    const entryName = /assets\/(index-[^"']+\.js)/.exec(indexHtml)?.[1];
    if (!entryName) {
      await fail("index.html does not reference a hashed JavaScript entry");
    } else {
      const entryStats = await stat(new URL(entryName, assetsDir));
      if (entryStats.size > maximumEntryBytes) {
        await fail(
          `JavaScript entry is ${entryStats.size} bytes; expected at most ${maximumEntryBytes} bytes so PDF.js stays lazy-loaded`,
        );
      }
    }
    if (!emittedReferences.includes(worker)) {
      await fail(`JavaScript output does not reference the emitted PDF worker: ${worker}`);
    }
    if (/pdf\.worker-[^"']+\.mjs/.test(emittedReferences)) {
      await fail("JavaScript output still references an .mjs PDF worker");
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
      if (!emittedReferences.includes(`/assets/pdfjs/${folder}/`)) {
        await fail(`JavaScript output does not reference local PDF.js ${folder}`);
      }
    }

    if (!process.exitCode) {
      console.log(`Web build verified: ${worker} (${workerStats.size} bytes)`);
    }
  }
} catch (error) {
  await fail(error instanceof Error ? error.message : String(error));
}
