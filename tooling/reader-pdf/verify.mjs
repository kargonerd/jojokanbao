#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const PDF_MAGIC = "%PDF-";
const MASK_SEED = 0x4a4f4a4f;
const DEFAULT_RANGE_CHUNK_SIZE = 65536;

function usage() {
  console.log(`Usage:
  pnpm verify:reader-pdf <file-or-url> [file-or-url...]

Options:
  --allow-plain              Report plain PDFs as pass instead of failure.
  --range-chunk-size <bytes> Override the reader-style range chunk size.

Checks:
  - protected bytes do not start with %PDF- and cannot be opened directly by pdf.js
  - applying the JOJO range-position mask restores a valid PDF
  - restored bytes can be opened by pdf.js
  - URL inputs support HTTP 206 byte ranges
`);
}

function parseArgs(argv) {
  const inputs = [];
  let allowPlain = false;
  let rangeChunkSize = DEFAULT_RANGE_CHUNK_SIZE;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--allow-plain") {
      allowPlain = true;
      continue;
    }
    if (arg === "--range-chunk-size") {
      const value = Number(argv[i + 1]);
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error("--range-chunk-size requires a positive integer");
      }
      rangeChunkSize = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    inputs.push(arg);
  }

  if (inputs.length === 0) {
    usage();
    process.exit(1);
  }

  return { allowPlain, inputs, rangeChunkSize };
}

function installPdfJsPolyfills() {
  if (!("DOMMatrix" in globalThis)) {
    globalThis.DOMMatrix = class DOMMatrix {};
  }
  if (!("try" in Promise)) {
    Promise.try = (fn, ...args) => Promise.resolve(fn(...args));
  }
  if (!("toHex" in Uint8Array.prototype)) {
    Object.defineProperty(Uint8Array.prototype, "toHex", {
      value() {
        return Array.from(this, (byte) => byte.toString(16).padStart(2, "0")).join("");
      },
    });
  }
}

function maskByteAt(position) {
  let x = (position + 0x9e3779b9) ^ MASK_SEED;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) & 0xff;
}

function applyMask(bytes, offset = 0) {
  const result = new Uint8Array(bytes);
  for (let i = 0; i < result.length; i += 1) {
    result[i] = (result[i] ?? 0) ^ maskByteAt(offset + i);
  }
  return result;
}

function hasPdfMagic(bytes) {
  if (bytes.length < PDF_MAGIC.length) return false;
  for (let i = 0; i < PDF_MAGIC.length; i += 1) {
    if (bytes[i] !== PDF_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

function parseContentRangeTotal(value) {
  if (!value) return null;
  const match = /^bytes\s+\d+-\d+\/(\d+|\*)$/i.exec(value.trim());
  if (!match || match[1] === "*") return null;
  const total = Number(match[1]);
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}

function parseContentLength(value) {
  if (!value) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}

async function openPdf(bytes) {
  const task = getDocument({ data: new Uint8Array(bytes), disableFontFace: true });
  const doc = await task.promise;
  const pageCount = doc.numPages;
  const firstPage = await doc.getPage(1);
  const textContent = await firstPage.getTextContent().catch(() => ({ items: [] }));
  await doc.destroy();
  return {
    pageCount,
    firstPageTextLength: textContent.items.map((item) => item.str ?? "").join("").length,
  };
}

async function canOpen(bytes) {
  try {
    return { ok: true, ...(await openPdf(bytes)) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function readFileInput(input) {
  const bytes = new Uint8Array(await readFile(resolve(input)));
  return { bytes, rangeSupported: null, totalLength: bytes.length };
}

async function fetchRange(url, begin, end) {
  const response = await fetch(url, { headers: { Range: `bytes=${begin}-${end - 1}` } });
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    bytes,
    status: response.status,
    totalLength:
      parseContentRangeTotal(response.headers.get("Content-Range")) ??
      parseContentLength(response.headers.get("Content-Length")) ??
      null,
  };
}

async function readUrlInput(input, rangeChunkSize) {
  const first = await fetchRange(input, 0, rangeChunkSize);
  if (first.status !== 206) {
    return {
      bytes: first.bytes,
      rangeSupported: false,
      totalLength: first.totalLength,
    };
  }

  const totalLength = first.totalLength;
  if (!Number.isSafeInteger(totalLength) || totalLength < first.bytes.length) {
    throw new Error("URL range response did not include a usable total length");
  }

  const bytes = new Uint8Array(totalLength);
  bytes.set(first.bytes, 0);
  for (let begin = first.bytes.length; begin < totalLength; begin += rangeChunkSize) {
    const end = Math.min(begin + rangeChunkSize, totalLength);
    const chunk = await fetchRange(input, begin, end);
    if (chunk.status !== 206) {
      throw new Error(`URL stopped honoring range requests at offset ${begin}`);
    }
    bytes.set(chunk.bytes, begin);
  }

  return { bytes, rangeSupported: true, totalLength };
}

async function readInput(input, rangeChunkSize) {
  return /^https?:\/\//i.test(input) ? readUrlInput(input, rangeChunkSize) : readFileInput(input);
}

async function verifyInput(input, options) {
  const { bytes, rangeSupported, totalLength } = await readInput(input, options.rangeChunkSize);
  const plain = hasPdfMagic(bytes);
  const decoded = plain ? bytes : applyMask(bytes);
  const decodedHasMagic = hasPdfMagic(decoded);
  const directOpen = await canOpen(bytes);
  const decodedOpen = decodedHasMagic ? await canOpen(decoded) : { ok: false, error: "decoded bytes do not start with %PDF-" };

  const pass = plain
    ? options.allowPlain && directOpen.ok
    : decodedHasMagic && !directOpen.ok && decodedOpen.ok && rangeSupported !== false;

  return {
    decodedHasMagic,
    decodedOpen,
    directOpen,
    input,
    pass,
    plain,
    rangeSupported,
    totalLength,
  };
}

function printResult(result) {
  const state = result.plain ? "plain" : result.decodedHasMagic ? "protected" : "unknown";
  const range = result.rangeSupported === null ? "n/a" : result.rangeSupported ? "206" : "no";
  const decodedPages = result.decodedOpen.ok ? result.decodedOpen.pageCount : "fail";
  const direct = result.directOpen.ok ? "opens" : "fails";
  const prefix = result.pass ? "PASS" : "FAIL";
  console.log(
    `${prefix} ${result.input} state=${state} range=${range} length=${result.totalLength} direct=${direct} decodedPages=${decodedPages}`
  );
  if (!result.pass) {
    if (result.plain) console.log("  reason: input is still a plain PDF; encode it before publishing");
    else if (!result.decodedHasMagic) console.log("  reason: input is neither plain nor JOJO-protected PDF");
    else if (result.directOpen.ok) console.log("  reason: protected bytes still open directly");
    else if (!result.decodedOpen.ok) console.log(`  reason: decoded bytes failed to open: ${result.decodedOpen.error}`);
    else if (result.rangeSupported === false) console.log("  reason: URL does not support HTTP range requests");
  }
}

async function main() {
  installPdfJsPolyfills();
  const options = parseArgs(process.argv.slice(2));
  const results = [];

  for (const input of options.inputs) {
    try {
      const result = await verifyInput(input, options);
      results.push(result);
      printResult(result);
    } catch (error) {
      results.push({ pass: false });
      console.log(`FAIL ${input} error=${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (results.some((result) => !result.pass)) {
    process.exitCode = 1;
  }
}

main();
