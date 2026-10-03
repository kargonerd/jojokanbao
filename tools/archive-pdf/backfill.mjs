#!/usr/bin/env node
// Magazine Delivery backfill: stage, upload, and verify a per-publication
// patch of full-issue PDFs for a Jox Delivery magazine dataset (hq/sjzs/rmhb).
// Newspapers use sync_rmrb.py instead; this tool covers the item-enumerated
// magazine datasets.
//
// Usage (run from the repository root):
//   pnpm backfill:archive-pdf -- stage  --publication hq --source <folder-with-<year>/<issue>.pdf>
//   pnpm backfill:archive-pdf -- upload --publication hq
//   pnpm backfill:archive-pdf -- verify --publication hq [--cdn <url>]
//
// stage   : protect PDFs + build manifests/index locally under tmp/magazine-backfill/<pub>/
// upload  : rclone assets first (immutable), then manifests, then index last
// verify  : decode index/manifests and check PDF magic + sha256 via the public CDN
//
// The jox codec mirrors frontend/packages/content/src/jox.ts and uses only
// Node built-ins (node:zlib), so no workspace dependency is required.

import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const LABELS = { hq: "红旗", sjzs: "世界知识", rmhb: "人民画报" };
const REMOTE = process.env.JOJO_DELIVERY_REMOTE || "jojo-b2-s3:jojo-newspaper";
const CDN = "https://blacknews.jojokanbao.cn";
const WORK = resolve("tmp", "magazine-backfill");

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function publication() {
  const id = argValue("--publication");
  const label = LABELS[id];
  if (!label) throw new Error(`--publication must be one of: ${Object.keys(LABELS).join(", ")}`);
  return { id, label, dataset: `content/newspapers/${id}`, indexKey: `content/newspapers/${id}/index.jox` };
}

// ── jox codec (mirrors frontend/packages/content/src/jox.ts) ──

const JOX_SALT = 0x4a4f5831; // "JOX1"

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(value, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function maskByte(position, seed) {
  let v = ((position >>> 0) + 0x9e3779b9) ^ seed ^ JOX_SALT;
  v ^= v >>> 16;
  v = Math.imul(v, 0x7feb352d);
  v ^= v >>> 15;
  v = Math.imul(v, 0x846ca68b);
  v ^= v >>> 16;
  return v & 0xff;
}

/** The transform is symmetric: applying it twice with the same key restores the input. */
function protect(bytes, key) {
  const seed = fnv1a(key.replaceAll("\\", "/").replace(/^\/+/, ""));
  const out = Buffer.alloc(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ maskByte(i, seed);
  return out;
}

function joxJson(json, key) {
  return protect(gzipSync(Buffer.from(JSON.stringify(json), "utf8")), key);
}

function joxDecode(bytes, key) {
  return JSON.parse(new TextDecoder().decode(gunzipSync(protect(bytes, key))));
}

// ── shared helpers ──

function run(args) {
  const result = spawnSync(args[0], args.slice(1), { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${args[0]} exited ${result.status}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  return result.stdout;
}

async function readLocalIndex(pub) {
  const cached = join(WORK, pub.id, `${pub.id}-index.jox.bin`);
  if (!existsSync(cached)) {
    await mkdir(join(WORK, pub.id), { recursive: true });
    run(["rclone", "copyto", `${REMOTE}/${pub.indexKey}`, cached]);
  }
  return joxDecode(await readFile(cached), pub.indexKey);
}

async function discoverIssues(source) {
  const years = (await readdir(source, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && /^\d{4}$/.test(e.name))
    .map((e) => e.name)
    .sort();
  const issues = [];
  for (const year of years) {
    for (const entry of await readdir(join(source, year))) {
      if (!entry.toLowerCase().endsWith(".pdf")) continue;
      const id = entry.slice(0, -4);
      if (/^\d{6}$/.test(id) && id.startsWith(year)) issues.push(id);
    }
  }
  return issues.sort();
}

function issueTitle(pub, issue) {
  return `${pub.label} ${issue.slice(0, 4)}年第${Number(issue.slice(4))}期`;
}

// ── stage ──

async function stage() {
  const pub = publication();
  const source = resolve(argValue("--source"));
  if (!source) throw new Error("--source is required");
  const stageDir = join(WORK, pub.id, "stage");
  const stagedList = join(WORK, `${pub.id}-staged-issues.json`);

  const issues = await discoverIssues(source);
  if (issues.length === 0) throw new Error("no <year>/<yyyymm>.pdf files found");
  const index = await readLocalIndex(pub);
  const known = new Set(index.items.map((i) => i.itemKey));
  const fresh = issues.filter((id) => !known.has(id));
  const duplicate = issues.filter((id) => known.has(id));
  console.log(`discovered ${issues.length} issues, ${fresh.length} new, ${duplicate.length} already published (${duplicate.join(", ") || "-"})`);

  let order = Math.max(...index.items.map((i) => i.order));
  const staged = [];
  for (const issue of fresh) {
    const year = issue.slice(0, 4);
    const plain = await readFile(join(source, year, `${issue}.pdf`));
    const sha256 = createHash("sha256").update(plain).digest("hex");
    const itemKey = `${pub.dataset}/items/${year}/${issue}`;
    const assetKey = `${itemKey}/assets/issue.pdf.jox`;
    const manifestKey = `${itemKey}/manifest.jox`;

    const manifest = {
      formatVersion: "jojo-item-manifest/1",
      revision: 1,
      itemId: `${pub.id}:${issue}`,
      datasetId: pub.id,
      type: "magazine",
      title: issueTitle(pub, issue),
      language: "zh-CN",
      publicationStatus: "published",
      access: "public",
      availability: { text: "missing", pdf: "available" },
      identifiers: { sourceIssueKey: issue },
      metadata: { publishedDate: null, issueNumber: issue.slice(4) },
      content: { schema: "jojo-content/magazine/1", articles: [] },
      contentStats: { articleCount: 0, availableArticleCount: 0, missingArticleCount: 0, characterCount: 0 },
      assets: [
        {
          id: `asset:issue-pdf-${sha256.slice(0, 16)}`,
          type: "pdf",
          role: "issue-pdf",
          mediaType: "application/pdf",
          title: `${issueTitle(pub, issue)} 原刊`,
          alt: null,
          caption: null,
          object: "assets/issue.pdf.jox",
          size: plain.length,
          sha256,
        },
      ],
      exports: [],
    };

    const itemDir = join(stageDir, pub.dataset, `items/${year}/${issue}`);
    await mkdir(join(itemDir, "assets"), { recursive: true });
    await writeFile(join(itemDir, "assets/issue.pdf.jox"), protect(plain, assetKey));
    await writeFile(join(itemDir, "manifest.jox"), joxJson(manifest, manifestKey));
    order += 1;
    index.items.push({
      itemId: `${pub.id}:${issue}`,
      itemKey: issue,
      type: "magazine",
      order,
      title: issueTitle(pub, issue),
      manifestObject: `items/${year}/${issue}/manifest.jox`,
      availability: { text: "missing", pdf: "available" },
    });
    staged.push(issue);
    if (staged.length % 20 === 0) console.log(`staged ${staged.length}/${fresh.length}`);
  }

  index.items.sort((a, b) => (a.itemKey < b.itemKey ? -1 : a.itemKey > b.itemKey ? 1 : 0));
  index.revision += 1;
  const indexDir = join(stageDir, pub.dataset);
  await mkdir(indexDir, { recursive: true });
  await writeFile(join(indexDir, "index.jox"), joxJson(index, pub.indexKey));
  await writeFile(stagedList, `${JSON.stringify(fresh, null, 1)}\n`);
  console.log(`stage complete: ${staged.length} new items, index revision ${index.revision} (${index.items.length} total)`);
}

// ── upload ──

function remoteObjectExists(key) {
  const result = spawnSync("rclone", ["lsf", `${REMOTE}/${key}`, "--files-only"], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim().length > 0;
}

async function upload() {
  const pub = publication();
  const stageDir = join(WORK, pub.id, "stage");
  const stagedIssues = JSON.parse(await readFile(join(WORK, `${pub.id}-staged-issues.json`), "utf8"));
  if (!Array.isArray(stagedIssues) || stagedIssues.length === 0) throw new Error("nothing staged");
  const flags = ["--checksum", "--transfers", "4", "--checkers", "8", "--s3-no-check-bucket", "--stats", "30s", "--stats-one-line"];

  let uploaded = 0;
  let skipped = 0;
  for (const issue of stagedIssues) {
    const year = issue.slice(0, 4);
    const assetKey = `${pub.dataset}/items/${year}/${issue}/assets/issue.pdf.jox`;
    if (remoteObjectExists(assetKey)) {
      skipped += 1;
    } else {
      run(["rclone", "copyto", join(stageDir, assetKey), `${REMOTE}/${assetKey}`, "--immutable", ...flags]);
      uploaded += 1;
    }
    if ((uploaded + skipped) % 10 === 0) console.log(`assets: ${uploaded} uploaded, ${skipped} skipped`);
  }
  console.log(`assets done: ${uploaded} uploaded, ${skipped} skipped`);

  let manifests = 0;
  for (const issue of stagedIssues) {
    const year = issue.slice(0, 4);
    const manifestKey = `${pub.dataset}/items/${year}/${issue}/manifest.jox`;
    run(["rclone", "copyto", join(stageDir, manifestKey), `${REMOTE}/${manifestKey}`, "--ignore-times", ...flags]);
    manifests += 1;
    if (manifests % 50 === 0) console.log(`manifests: ${manifests}/${stagedIssues.length}`);
  }
  console.log(`manifests done: ${manifests}`);

  run(["rclone", "copyto", join(stageDir, pub.indexKey), `${REMOTE}/${pub.indexKey}`, "--ignore-times", ...flags]);
  console.log("index uploaded");
}

// ── verify ──

async function fetchJox(key, revision) {
  const url = `${argValue("--cdn", CDN)}/${key}${revision ? `?v=${revision}` : ""}`;
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${key}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    try {
      return joxDecode(bytes, key);
    } catch (error) {
      lastError = error;
      console.error(`decode failed (attempt ${attempt}) for ${key}: status=${response.status} len=${bytes.length}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastError;
}

async function verify() {
  const pub = publication();
  const stagedIssues = JSON.parse(await readFile(join(WORK, `${pub.id}-staged-issues.json`), "utf8"));
  const index = await fetchJox(pub.indexKey);
  const missing = stagedIssues.filter((id) => !index.items.some((i) => i.itemKey === id));
  if (missing.length > 0) throw new Error(`CDN index still missing ${missing.length} issues (edge cache?): ${missing.slice(0, 5).join(", ")}`);
  console.log(`CDN index OK: ${stagedIssues.length}/${stagedIssues.length} staged issues present (${index.items.length} total)`);

  let checked = 0;
  for (const issue of stagedIssues) {
    const year = issue.slice(0, 4);
    const manifestKey = `${pub.dataset}/items/${year}/${issue}/manifest.jox`;
    const manifest = await fetchJox(manifestKey);
    const asset = manifest.assets.find((a) => a.role === "issue-pdf");
    if (!asset) throw new Error(`no issue-pdf asset in ${manifestKey}`);
    // PDF assets are mask-transformed raw bytes, not gzipped JSON.
    const assetKey = `${pub.dataset}/items/${year}/${issue}/assets/issue.pdf.jox`;
    const response = await fetch(`${argValue("--cdn", CDN)}/${assetKey}?v=${asset.sha256}`);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${assetKey}`);
    const protectedBytes = new Uint8Array(await response.arrayBuffer());
    const pdf = protect(protectedBytes, assetKey);
    if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error(`bad PDF magic for ${issue}`);
    const sha256 = createHash("sha256").update(pdf).digest("hex");
    if (sha256 !== asset.sha256) throw new Error(`sha mismatch for ${issue}`);
    checked += 1;
    if (checked % 5 === 0) console.log(`verified ${checked}/${stagedIssues.length}`);
  }
  console.log(`verify complete: ${checked} issues checked through the public CDN`);
}

// ── main ──

const mode = process.argv[2];
if (mode === "stage") await stage();
else if (mode === "upload") await upload();
else if (mode === "verify") await verify();
else {
  console.log("usage: node tools/archive-pdf/backfill.mjs <stage|upload|verify> --publication <hq|sjzs|rmhb> [--source <dir>]");
  process.exit(1);
}
