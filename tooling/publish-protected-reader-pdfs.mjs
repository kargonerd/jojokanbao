#!/usr/bin/env node
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const MASK_SEED = 0x4a4f4a4f;
const PDF_MAGIC = "%PDF-";
const CACHE_CONTROL = "public, max-age=315360000, immutable";
const DEFAULT_QPDF = "C:\\Program Files\\qpdf 12.3.2\\bin\\qpdf.exe";
const DEFAULT_PIPE_CONFIG = resolve("services", "jojo-pipe", "config.json");
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
  --source <path>           Local plain-PDF root containing <year>/<issue>.pdf.
                            If omitted, uses publications.<code>.source_path from pipe config.
  --pipe-config <path>      JOJO Pipe config. Default: ${DEFAULT_PIPE_CONFIG}
  --remote <remote:path>    Override destination rclone remote root.
  --qpdf <path>             qpdf executable path.
  --dry-run                 Prepare and verify files without uploading.

Flow:
  local source PDF -> qpdf --linearize -> JOJO byte mask -> verifier -> configured storage target
`);
}

function parseArgs(argv) {
  const result = {
    collection: null,
    dryRun: false,
    issues: [],
    pipeConfig: DEFAULT_PIPE_CONFIG,
    qpdf: DEFAULT_QPDF,
    remote: null,
    source: null,
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
    if (arg === "--collection") {
      result.collection = argv[++i];
      continue;
    }
    if (arg === "--issue") {
      result.issues.push(argv[++i]);
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
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!result.collection || !COLLECTIONS[result.collection]) {
    throw new Error("--collection is required");
  }
  if (result.issues.length === 0) {
    throw new Error("--issue is required");
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
  if (!backend && remoteOverride) {
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
  const outDir = join(WORK_DIR, args.collection, year);
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

async function publishOne(storage, item) {
  if (storage.type === "local") {
    if (await localTargetExists(item.target)) {
      throw new Error(`Target already exists: ${item.target}`);
    }
    await mkdir(dirname(item.target), { recursive: true });
    await copyFile(item.local, item.target);
    return;
  }

  if (rcloneTargetExists(storage, item.target)) {
    throw new Error(`Target already exists: ${item.target}`);
  }

  const uploadHeaders = {
    "Cache-Control": CACHE_CONTROL,
    ...storage.uploadHeaders,
  };
  const args = ["rclone", "copyto", item.local, item.target];
  for (const [name, value] of Object.entries(uploadHeaders)) {
    args.push("--header-upload", `${name}: ${value}`);
  }
  if (storage.immutable) {
    args.push("--immutable");
  }
  args.push(
    "--retries",
    String(storage.retries),
    "--low-level-retries",
    String(storage.lowLevelRetries),
    "--progress",
    ...storage.rcloneArgs,
  );
  run(args);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const collection = COLLECTIONS[args.collection];
  const pipeConfig = await loadPipeConfig(args.pipeConfig);
  const pub = pipeConfig.publications?.[collection.pubCode];
  const sourceRoot = args.source || pub?.source_path;
  if (!sourceRoot) {
    throw new Error(`--source is required because ${collection.pubCode}.source_path is not configured`);
  }

  const storage = resolvePublicationStorage(pipeConfig, collection.pubCode, args.remote);
  const prepared = [];

  for (const issue of args.issues) {
    prepared.push(await prepareOne(args, collection, sourceRoot, storage, issue));
  }

  if (args.dryRun) {
    console.log("Dry run complete. Prepared files:");
    for (const item of prepared) {
      console.log(`${item.local} -> ${item.target}`);
    }
    return;
  }

  for (const item of prepared) {
    await publishOne(storage, item);
  }

  await rm(dirname(prepared[0].local), { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
