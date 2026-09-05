#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const baseUrl = process.env.READER_BASE_URL;
const revision = process.env.READER_DEPLOY_REVISION || Date.now().toString(36);
const distUrl = new URL("../dist/", import.meta.url);
const assetsUrl = new URL("assets/", distUrl);
const attempts = 10;

if (!baseUrl) {
  throw new Error("READER_BASE_URL is required");
}

const localHtml = await readFile(new URL("index.html", distUrl), "utf8");
const localEntry = /assets\/(index-[^"']+\.js)/.exec(localHtml)?.[1];
const localAssets = await readdir(assetsUrl);
const localWorkers = localAssets.filter((name) => name.startsWith("pdf.worker-"));
const runtimeAssetDirs = ["pdfjs/cmaps", "pdfjs/wasm", "pdfjs/standard_fonts"];
const spaRoutes = ["archive", "archive/rmrb/19761009", "reader/rmrb/19761009", "rmrb/19761009", "download", "download/iphone"];

if (!localEntry || localWorkers.length !== 1) {
  throw new Error("Local Web build is missing its entry or unique PDF worker");
}

const expectedWorker = localWorkers[0];
const localRuntimeChunks = await Promise.all(
  localAssets
    .filter((name) => name.endsWith(".js") && name !== expectedWorker)
    .map(async (name) => ({
      name,
      source: await readFile(new URL(name, assetsUrl), "utf8"),
    })),
);
const expectedRuntimeChunk = localRuntimeChunks.find(({ source }) => source.includes(expectedWorker))?.name;
if (!expectedRuntimeChunk) {
  throw new Error(`Local Web build has no runtime chunk referencing ${expectedWorker}`);
}
const runtimeAssetSamples = await Promise.all(runtimeAssetDirs.map(async (directory) => {
  const files = await readdir(new URL(`${directory}/`, assetsUrl));
  if (!files.length) throw new Error(`Local Web build has no ${directory} assets`);
  return `assets/${directory}/${files[0]}`;
}));
let lastError = new Error("Deployment verification did not run");

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const pageUrl = new URL(baseUrl);
    pageUrl.searchParams.set("deploy", revision);
    pageUrl.searchParams.set("attempt", String(attempt));

    const pageResponse = await fetch(pageUrl, { cache: "no-store" });
    if (!pageResponse.ok) throw new Error(`HTML returned HTTP ${pageResponse.status}`);
    const pageHtml = await pageResponse.text();
    const remoteEntry = /assets\/(index-[^"']+\.js)/.exec(pageHtml)?.[1];
    if (remoteEntry !== localEntry) {
      throw new Error(`HTML references ${remoteEntry || "no entry"}; expected ${localEntry}`);
    }

    // A successful SPA upload does not prove Python functions were registered.
    // Both probes are read-only and must never synthesize audio during deploy.
    for (const apiPath of ["/api/v1/health", "/api/v1/speech/providers"]) {
      const apiUrl = new URL(apiPath, baseUrl);
      apiUrl.searchParams.set("deploy", revision);
      const apiResponse = await fetch(apiUrl, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
      if (!apiResponse.ok || !/application\/json\b/i.test(apiResponse.headers.get("content-type") || "")) {
        throw new Error(`${apiPath} must return API JSON, not an SPA fallback (HTTP ${apiResponse.status})`);
      }
      const api = await apiResponse.json();
      if (apiPath.endsWith("/health") ? api?.service !== "jojokanbao-api" || api?.status !== "ok"
        : !Array.isArray(api?.providers) || !api.providers.some((provider) => provider.id === "mimo")) {
        throw new Error(`${apiPath} returned an unexpected API contract`);
      }
    }

    for (const route of spaRoutes) {
      const routeUrl = new URL(`/${route}`, baseUrl);
      routeUrl.searchParams.set("deploy", revision);
      routeUrl.searchParams.set("attempt", String(attempt));
      const routeResponse = await fetch(routeUrl, { cache: "no-store" });
      if (!routeResponse.ok) throw new Error(`/${route} returned HTTP ${routeResponse.status}`);
      const routeHtml = await routeResponse.text();
      const routeEntry = /assets\/(index-[^"']+\.js)/.exec(routeHtml)?.[1];
      if (routeEntry !== localEntry) {
        throw new Error(`/${route} references ${routeEntry || "no entry"}; expected ${localEntry}`);
      }
    }

    const entryUrl = new URL(`assets/${localEntry}`, baseUrl);
    entryUrl.searchParams.set("deploy", revision);
    const entryResponse = await fetch(entryUrl, { cache: "no-store" });
    if (!entryResponse.ok) throw new Error(`Entry returned HTTP ${entryResponse.status}`);
    const entry = await entryResponse.text();
    if (!entry.includes(expectedRuntimeChunk)) {
      throw new Error(`Entry does not reference ${expectedRuntimeChunk}`);
    }

    const runtimeUrl = new URL(`assets/${expectedRuntimeChunk}`, baseUrl);
    runtimeUrl.searchParams.set("deploy", revision);
    const runtimeResponse = await fetch(runtimeUrl, { cache: "no-store" });
    if (!runtimeResponse.ok) throw new Error(`Reader runtime returned HTTP ${runtimeResponse.status}`);
    const runtimeSource = await runtimeResponse.text();
    if (!runtimeSource.includes(expectedWorker)) {
      throw new Error(`${expectedRuntimeChunk} does not reference ${expectedWorker}`);
    }
    for (const directory of runtimeAssetDirs) {
      if (!runtimeSource.includes(`/assets/${directory}/`)) {
        throw new Error(`${expectedRuntimeChunk} does not reference /assets/${directory}/`);
      }
    }

    const workerUrl = new URL(`assets/${expectedWorker}`, baseUrl);
    workerUrl.searchParams.set("deploy", revision);
    const workerResponse = await fetch(workerUrl, { method: "HEAD", cache: "no-store" });
    const workerType = workerResponse.headers.get("content-type") || "";
    if (!workerResponse.ok) throw new Error(`Worker returned HTTP ${workerResponse.status}`);
    if (!/^(application|text)\/javascript\b/i.test(workerType)) {
      throw new Error(`Worker has invalid Content-Type: ${workerType || "missing"}`);
    }

    for (const assetPath of runtimeAssetSamples) {
      const assetUrl = new URL(assetPath, baseUrl);
      assetUrl.searchParams.set("deploy", revision);
      const assetResponse = await fetch(assetUrl, { method: "HEAD", cache: "no-store" });
      if (!assetResponse.ok) throw new Error(`${assetPath} returned HTTP ${assetResponse.status}`);
    }

    console.log(
      `Web deployment verified: API health/speech providers, SPA routes, ${localEntry} -> ${expectedRuntimeChunk} -> ${expectedWorker}, and PDF runtime assets (${workerType})`,
    );
    process.exit(0);
  } catch (error) {
    lastError = error instanceof Error ? error : new Error(String(error));
    if (attempt < attempts) await delay(3_000);
  }
}

throw new Error(`Web deployment verification failed after ${attempts} attempts: ${lastError.message}`);
