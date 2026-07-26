#!/usr/bin/env node
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

const MASK_SEED = 0x4a4f4a4f;
const PDF_MAGIC = "%PDF-";

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

function usage() {
  console.log(`Usage:
  pnpm protect:reader-pdf encode <input.pdf|dir> [output.pdf] [--recursive] [--force]
  pnpm protect:reader-pdf decode <input.pdf|dir> [output.pdf] [--recursive] [--force]

Notes:
  - encode makes a CDN-served .pdf unreadable until the reader decodes byte ranges.
  - decode reverses the same operation.
  - With a directory input, files are updated in place and only *.pdf files are processed.
  - The operation preserves file length, so HTTP Range offsets remain valid.
  - The tool skips already-encoded files unless --force is provided.
  - For S3, sync/download objects first, run this tool locally, then sync/upload them back.
`);
}

function parseArgs(argv) {
  const [command, input, ...rest] = argv;
  const flags = new Set();
  let output = null;

  for (const arg of rest) {
    if (arg.startsWith("-")) {
      flags.add(arg);
    } else if (!output) {
      output = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  const helpRequested = command === "--help" || command === "-h" || flags.has("--help") || flags.has("-h");
  if (helpRequested || !["encode", "decode"].includes(command) || !input) {
    usage();
    process.exit(helpRequested ? 0 : 1);
  }
  return {
    command,
    input: resolve(input),
    output: output ? resolve(output) : null,
    recursive: flags.has("--recursive"),
    force: flags.has("--force"),
  };
}

async function readFirstBytes(file, length) {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
  } finally {
    await handle.close();
  }
}

async function classifyFile(file) {
  const firstBytes = await readFirstBytes(file, PDF_MAGIC.length);
  if (hasPdfMagic(firstBytes)) return "plain";
  if (hasPdfMagic(applyMask(new Uint8Array(firstBytes), 0))) return "protected";
  return "unknown";
}

function expectedInputState(command) {
  return command === "encode" ? "plain" : "protected";
}

function skippedState(command) {
  return command === "encode" ? "protected" : "plain";
}

async function transformFile(input, output) {
  let offset = 0;
  await mkdir(dirname(output), { recursive: true });
  await pipeline(
    createReadStream(input),
    new Transform({
      transform(chunk, _encoding, callback) {
        const bytes = applyMask(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), offset);
        offset += bytes.length;
        callback(null, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      },
    }),
    createWriteStream(output)
  );
}

async function transformInPlace(file, command, force) {
  const state = await classifyFile(file);
  if (!force && state === skippedState(command)) {
    return { file, status: "skipped", reason: `already ${state}` };
  }
  if (!force && state !== expectedInputState(command)) {
    return { file, status: "skipped", reason: `not a ${expectedInputState(command)} PDF` };
  }

  const tempFile = join(dirname(file), `.${basename(file)}.jojo-${process.pid}.tmp`);
  await transformFile(file, tempFile);
  await copyFile(tempFile, file);
  await rm(tempFile, { force: true });
  return { file, status: "updated" };
}

async function collectPdfFiles(dir, recursive) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) files.push(...(await collectPdfFiles(fullPath, recursive)));
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".pdf") {
      files.push(fullPath);
    }
  }
  return files;
}

async function main() {
  const { command, input, output, recursive, force } = parseArgs(process.argv.slice(2));
  const inputStat = await stat(input);

  if (inputStat.isDirectory()) {
    if (output) throw new Error("Directory mode updates files in place; output path is not supported");
    const files = await collectPdfFiles(input, recursive);
    const results = [];
    for (const file of files) {
      results.push(await transformInPlace(file, command, force));
    }
    for (const result of results) {
      console.log(`${result.status}: ${result.file}${result.reason ? ` (${result.reason})` : ""}`);
    }
    console.log(`${command} complete: ${results.filter((result) => result.status === "updated").length}/${results.length} updated`);
    return;
  }

  if (!inputStat.isFile()) {
    throw new Error(`Input is not a file or directory: ${input}`);
  }

  if (!output) {
    const result = await transformInPlace(input, command, force);
    console.log(`${result.status}: ${result.file}${result.reason ? ` (${result.reason})` : ""}`);
    return;
  }

  const state = await classifyFile(input);
  if (!force && state !== expectedInputState(command)) {
    throw new Error(`Refusing to ${command} ${input}: expected ${expectedInputState(command)} PDF, got ${state}`);
  }
  await transformFile(input, output);
  console.log(`${command}: ${input} -> ${output}`);
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
