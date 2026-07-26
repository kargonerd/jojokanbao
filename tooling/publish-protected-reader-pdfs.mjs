#!/usr/bin/env node
import { copyFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const MASK_SEED = 0x4a4f4a4f;
const PDF_MAGIC = "%PDF-";
const CACHE_CONTROL = "public, max-age=315360000, immutable";
const DEFAULT_QPDF = process.env.QPDF_BIN || "qpdf";
const DEFAULT_PIPE_CONFIG = resolve("internal", "data-workbench", "server", "config.json");
const WORK_DIR = resolve("tmp", "protected-reader-publish");

const COLLECTIONS = {
  rmrb: { pubCode: "RMRB", idPattern: /^\d{8}$/ },
  rmhb: { pubCode: "RMHB", idPattern: /^\d{6}$/ },
  ckxx: { pubCode: "CKXX", idPattern: /^\d{8}$/ },
  hq: { pubCode: "HQ", idPattern: /^\d{6}$/ },
  sjzs: { pubCode: "SJZS", idPattern: /^\d{6}$/ },
};

function usage() {
  console.log(`Usage:
  node tooling/publish-protected-reader-pdfs.mjs --collection rmrb --source <local-root> --issue 19460515

Options:
  --collection <name>       One of: ${Object.keys(COLLECTIONS).join(", ")}
  --issue <yyyymmdd|yyyymm> Issue id. Can be repeated.
  --all                     Discover every PDF under <source>/<year>/.
  --from <issue>            Include issues at or after this id.
  --to <issue>              Include issues at or before this id.
  --source <path>           Local plain-PDF root containing <year>/<issue>.pdf.
                            If omitted, uses publications.<code>.source_path from pipe config.
  --pipe-config <path>      JOJO Pipe config. Default: ${DEFAULT_PIPE_CONFIG}
  --remote <remote:path>    Override destination rclone remote root.
  --qpdf <path>             qpdf executable path.
  --force                   Overwrite an existing destination object.
  --resume                  Skip successful issues recorded in the state file.
  --state <path>            Resume-state JSON path. Defaults under ${WORK_DIR}.
  --continue-on-error       Record a failure and continue with the next issue.
  --dry-run                 Prepare and verify files without uploading.

Environment:
  QPDF_BIN                  qpdf executable used when --qpdf is omitted.

Flow:
  local source PDF -> qpdf --linearize -> JOJO byte mask -> verifier -> configured storage target
`);
}

function parseArgs(argv) {
  const result = {
    all: false,
    collection: null,
    continueOnError: false,
    dryRun: false,
    force: false,
    from: null,
    issues: [],
    pipeConfig: DEFAULT_PIPE_CONFIG,
    qpdf: DEFAULT_QPDF,
    remote: null,
    resume: false,
    source: null,
    state: null,
    to: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--dry-run") {
      result.dryRun = true;
      continue;
    }
    if (arg === "--all") {
      result.all = true;
      continue;
    }
    if (arg === "--continue-on-error") {
      result.continueOnError = true;
      continue;
    }
    if (arg === "--force") {
      result.force = true;
      continue;
    }
    if (arg === "--resume") {
      result.resume = true;
      continue;
    }
    if (arg === "--collection") {
      result.collection = argv[++i];
      continue;
    }
    if (arg === "--issue") {
      result.issues.push(argv[++i]);
      continue;
    }
    if (arg === "--from") {
      result.from = argv[++i];
      continue;
    }
    if (arg === "--to") {
      result.to = argv[++i];
      continue;
    }
    if (arg === "--pipe-config") {
      result.pipeConfig = resolve(argv[++i]);
      continue;
    }
    if (arg === "--qpdf") {
      result.qpdf = argv[++i];
      continue;
    }
    if (arg === "--remote") {
      result.remote = argv[++i];
      continue;
    }
    if (arg === "--source") {
      result.source = argv[++i];
      continue;
    }
    if (arg === "--state") {
      result.state = resolve(argv[++i]);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!result.collection || !COLLECTIONS[result.collection]) {
    throw new Error("--collection is required");
  }
  if (result.issues.length === 0 && !result.all) {
    throw new Error("At least one --issue or --all is required");
  }
  return result;
}

function run(args, options = {}) {
  console.log(`$ ${args.join(" ")}`);
  const result = spawnSync(args[0], args.slice(1), {
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.status !== 0 && !(options.allowQpdfWarning && result.status === 3)) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`${args[0]} exited with ${result.status}${output ? `\n${output}` : ""}`);
  }
  return result;
}

function normalizeKey(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
}

function joinKey(...parts) {
  return parts.map(normalizeKey).filter(Boolean).join("/");
}

function formatPrefix(template, pubCode) {
  return normalizeKey(template.replaceAll("{code}", pubCode).replaceAll("{code_lower}", pubCode.toLowerCase()));
}

async function loadPipeConfig(configPath) {
  return JSON.parse(await readFile(configPath, "utf8"));
}

function resolvePublicationStorage(pipeConfig, pubCode, remoteOverride = null) {
  if (remoteOverride) {
    return {
      type: "rclone",
      backendName: "cli-remote",
      remote: remoteOverride,
      processedPrefix: pubCode,
      uploadHeaders: {},
      rcloneArgs: [],
      immutable: true,
      retries: 5,
      lowLevelRetries: 10,
    };
  }

  const pub = pipeConfig.publications?.[pubCode];
  if (!pub) {
    throw new Error(`Publication ${pubCode} not found in ${DEFAULT_PIPE_CONFIG}`);
  }

  const storageRoot = pipeConfig.storage || {};
  const storageConfig = pub.storage || {};
  const backendName =
    (typeof storageConfig === "string" ? storageConfig : storageConfig.backend || storageConfig.name) ||
    storageRoot.default_backend;
  const backend = storageRoot.backends?.[backendName];
  if (!backend) {
    throw new Error(`Storage backend for ${pubCode} is not configured`);
  }

  const processedTemplate =
    storageConfig.processed_prefix ||
    backend.processed_prefix ||
    "{code}";

  return {
    type: backend.type || "local",
    backendName,
    remote: remoteOverride || backend.remote,
    root: backend.root,
    processedPrefix: formatPrefix(processedTemplate, pubCode),
    uploadHeaders: backend.upload_headers || {},
    rcloneArgs: backend.rclone_args || [],
    immutable: backend.immutable !== false,
    retries: Number(backend.retries || 5),
    lowLevelRetries: Number(backend.low_level_retries || 10),
  };
}

function targetFor(storage, year, filename) {
  const key = joinKey(storage.processedPrefix, year, filename);
  if (storage.type === "rclone") {
    return `${storage.remote.replace(/\/+$/g, "")}/${key}`;
  }
  if (storage.type === "local") {
    return join(storage.root, ...key.split("/"));
  }
  throw new Error(`Unsupported storage type: ${storage.type}`);
}

function maskByteAt(position) {
  let x = (position + 0x9e3779b9) ^ MASK_SEED;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) & 0xff;
}

function applyMask(bytes, offset = 0) {
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = (bytes[i] ?? 0) ^ maskByteAt(offset + i);
  }
  return bytes;
}

function hasPdfMagic(bytes) {
  if (bytes.length < PDF_MAGIC.length) return false;
  for (let i = 0; i < PDF_MAGIC.length; i += 1) {
    if (bytes[i] !== PDF_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

function yearForIssue(issue) {
  return issue.slice(0, 4);
}

async function prepareOne(args, collection, sourceRoot, storage, issue) {
  if (!collection.idPattern.test(issue)) {
    throw new Error(`Invalid ${args.collection} issue id: ${issue}`);
  }

  const year = yearForIssue(issue);
  const source = join(sourceRoot, year, `${issue}.pdf`);
  const outDir = join(WORK_DIR, "work", args.collection, issue);
  const linearized = join(outDir, `${issue}.linearized.pdf`);
  const protectedPdf = join(outDir, `${issue}.pdf`);
  await mkdir(outDir, { recursive: true });

  run([args.qpdf, "--linearize", source, linearized], { allowQpdfWarning: true });
  const check = run([args.qpdf, "--check-linearization", linearized], {
    allowQpdfWarning: true,
    capture: true,
  });
  const checkOutput = `${check.stdout ?? ""}\n${check.stderr ?? ""}`;
  if (!checkOutput.includes("no linearization errors")) {
    throw new Error(`qpdf linearization check failed for ${source}`);
  }

  const bytes = new Uint8Array(await readFile(linearized));
  if (!hasPdfMagic(bytes)) {
    throw new Error(`qpdf output is not a plain PDF: ${linearized}`);
  }
  await writeFile(protectedPdf, applyMask(bytes));

  run(["node", "tooling/verify-reader-pdf-protection.mjs", protectedPdf]);
  return {
    issue,
    local: protectedPdf,
    outDir,
    source,
    target: targetFor(storage, year, basename(protectedPdf)),
  };
}

function rcloneTargetExists(storage, target) {
  const result = spawnSync("rclone", ["lsf", target, "--files-only", ...storage.rcloneArgs], {
    encoding: "utf8",
    stdio: "pipe",
  });
  return result.status === 0 && result.stdout.trim().length > 0;
}

async function localTargetExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function publishOne(storage, item, force) {
  if (storage.type === "local") {
    if (!force && (await localTargetExists(item.target))) {
      throw new Error(`Target already exists: ${item.target}`);
    }
    await mkdir(dirname(item.target), { recursive: true });
    await copyFile(item.local, item.target);
    return;
  }

  if (!force && rcloneTargetExists(storage, item.target)) {
    throw new Error(`Target already exists: ${item.target}`);
  }

  const uploadHeaders = {
    "Cache-Control": CACHE_CONTROL,
    ...storage.uploadHeaders,
  };
  const args = ["rclone", "copyto", item.local, item.target];
  if (force) {
    // Protected PDFs retain the source size. Force rclone to replace an
    // existing plain PDF even when the backend cannot compare modification
    // times reliably and would otherwise treat equal sizes as unchanged.
    args.push("--ignore-times");
  }
  for (const [name, value] of Object.entries(uploadHeaders)) {
    args.push("--header-upload", `${name}: ${value}`);
  }
  if (storage.immutable && !force) {
    args.push("--immutable");
  }
  args.push(
    "--retries",
    String(storage.retries),
    "--low-level-retries",
    String(storage.lowLevelRetries),
    "--stats",
    "30s",
    "--stats-one-line",
    ...storage.rcloneArgs,
  );
  run(args);
}

async function discoverIssues(sourceRoot, collection) {
  const issues = [];
  const years = (await readdir(sourceRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d{4}$/.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const year of years) {
    const entries = await readdir(join(sourceRoot, year.name), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".pdf")) continue;
      const issue = entry.name.slice(0, -4);
      if (collection.idPattern.test(issue) && issue.startsWith(year.name)) issues.push(issue);
    }
  }
  return issues.sort();
}

function validateBoundary(collection, value, flag) {
  if (value && !collection.idPattern.test(value)) {
    throw new Error(`${flag} is not a valid issue id: ${value}`);
  }
}

async function selectedIssues(args, collection, sourceRoot) {
  validateBoundary(collection, args.from, "--from");
  validateBoundary(collection, args.to, "--to");
  if (args.from && args.to && args.from > args.to) throw new Error("--from must not be after --to");

  const issues = new Set(args.issues);
  if (args.all) {
    for (const issue of await discoverIssues(sourceRoot, collection)) issues.add(issue);
  }
  return [...issues]
    .filter((issue) => (!args.from || issue >= args.from) && (!args.to || issue <= args.to))
    .sort();
}

async function loadState(statePath) {
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    return state.version === 1 && state.completed ? state : { version: 1, completed: {} };
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1, completed: {} };
    throw error;
  }
}

async function saveState(statePath, state) {
  await mkdir(dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
  await rename(temporary, statePath);
}

function sameSource(record, source, sourceStat) {
  return (
    record?.source === source &&
    record?.size === sourceStat.size &&
    Math.trunc(record?.mtimeMs) === Math.trunc(sourceStat.mtimeMs)
  );
}

function expectedProtectedPrefix() {
  return applyMask(new Uint8Array(Buffer.from(PDF_MAGIC, "ascii")));
}

async function verifyPublished(storage, item) {
  const localSize = (await stat(item.local)).size;
  if (storage.type === "local") {
    const targetBytes = new Uint8Array(await readFile(item.target));
    if (targetBytes.length !== localSize) throw new Error(`Published size mismatch: ${item.target}`);
    if (!Buffer.from(targetBytes.subarray(0, PDF_MAGIC.length)).equals(Buffer.from(expectedProtectedPrefix()))) {
      throw new Error(`Published target is not protected: ${item.target}`);
    }
    return;
  }

  const sampleLength = Math.min(32, localSize);
  // A successful single-object S3 PUT already has transport integrity checks.
  // Read the protected prefix back to ensure the destination was actually
  // replaced, without paying for three new rclone processes per issue.
  const offsets = [0];
  const handle = await open(item.local, "r");
  try {
    for (const offset of offsets) {
      const expected = Buffer.alloc(sampleLength);
      const { bytesRead } = await handle.read(expected, 0, sampleLength, offset);
      const remote = spawnSync(
        "rclone",
        ["cat", item.target, "--offset", String(offset), "--count", String(bytesRead), ...storage.rcloneArgs],
        { encoding: null, stdio: "pipe" },
      );
      if (remote.status !== 0) {
        throw new Error(`Unable to read uploaded bytes at ${offset}: ${item.target}\n${remote.stderr?.toString() ?? ""}`);
      }
      if (!Buffer.from(remote.stdout).equals(expected.subarray(0, bytesRead))) {
        throw new Error(`Uploaded bytes differ at ${offset}: ${item.target}`);
      }
    }
  } finally {
    await handle.close();
  }
  const prefix = Buffer.alloc(PDF_MAGIC.length);
  const protectedHandle = await open(item.local, "r");
  try {
    await protectedHandle.read(prefix, 0, prefix.length, 0);
  } finally {
    await protectedHandle.close();
  }
  if (!prefix.equals(Buffer.from(expectedProtectedPrefix()))) {
    throw new Error(`Local upload candidate is not JOJO-protected: ${item.local}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const collection = COLLECTIONS[args.collection];
  let pipeConfig = {};
  try {
    pipeConfig = await loadPipeConfig(args.pipeConfig);
  } catch (error) {
    if (error?.code !== "ENOENT" || !args.remote || !args.source) throw error;
  }
  const pub = pipeConfig.publications?.[collection.pubCode];
  const sourceRoot = args.source || pub?.source_path;
  if (!sourceRoot) {
    throw new Error(`--source is required because ${collection.pubCode}.source_path is not configured`);
  }

  const storage = resolvePublicationStorage(pipeConfig, collection.pubCode, args.remote);
  const issues = await selectedIssues(args, collection, sourceRoot);
  if (issues.length === 0) throw new Error("No matching PDF issues were found");
  const statePath = args.state || join(WORK_DIR, "state", `${args.collection}.json`);
  const state = await loadState(statePath);
  const failures = [];
  let completed = 0;
  let skipped = 0;

  console.log(`Selected ${issues.length} ${collection.pubCode} issue(s) from ${sourceRoot}`);
  for (let index = 0; index < issues.length; index += 1) {
    const issue = issues[index];
    const source = join(sourceRoot, yearForIssue(issue), `${issue}.pdf`);
    let item = null;
    try {
      const sourceStat = await stat(source);
      if (args.resume && sameSource(state.completed[issue], source, sourceStat)) {
        skipped += 1;
        console.log(`[${index + 1}/${issues.length}] SKIP ${issue} (resume state)`);
        continue;
      }

      console.log(`[${index + 1}/${issues.length}] PREPARE ${issue}`);
      item = await prepareOne(args, collection, sourceRoot, storage, issue);
      if (args.dryRun) {
        console.log(`[${index + 1}/${issues.length}] VERIFIED ${item.local} -> ${item.target}`);
      } else {
        await publishOne(storage, item, args.force);
        await verifyPublished(storage, item);
        state.completed[issue] = {
          completedAt: new Date().toISOString(),
          mtimeMs: sourceStat.mtimeMs,
          size: sourceStat.size,
          source,
          target: item.target,
        };
        await saveState(statePath, state);
        console.log(`[${index + 1}/${issues.length}] PUBLISHED ${issue}`);
      }
      completed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ issue, message });
      console.error(`[${index + 1}/${issues.length}] FAILED ${issue}: ${message}`);
      if (!args.continueOnError) throw error;
    } finally {
      if (item?.outDir) await rm(item.outDir, { recursive: true, force: true });
      else await rm(join(WORK_DIR, "work", args.collection, issue), { recursive: true, force: true });
    }
  }

  console.log(`Complete: processed=${completed} skipped=${skipped} failed=${failures.length} state=${statePath}`);
  if (failures.length > 0) {
    throw new Error(`${failures.length} issue(s) failed; rerun with --resume after correcting them`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
