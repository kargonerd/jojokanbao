import { PDFDataRangeTransport } from "pdfjs-dist";

const PDF_MAGIC = "%PDF-";
export const DEFAULT_PDF_RANGE_CHUNK_SIZE = 256 * 1024;
const DEFAULT_PDF_DOWNLOAD_RANGE_CHUNK_SIZE = 1024 * 1024;
const DEFAULT_PDF_DOWNLOAD_CONCURRENCY = 6;
const MASK_SEED = 0x4a4f4a4f; // "JOJO"

export type ProtectedPdfMode = boolean | "auto";

export interface ProtectedPdfFetchOptions {
  fetchFn?: typeof fetch;
  headers?: HeadersInit;
  rangeChunkSize?: number;
  withCredentials?: boolean;
  onRangeError?: (error: Error) => void;
  downloadConcurrency?: number;
  onDownloadProgress?: (loadedBytes: number, totalBytes: number) => void;
}

export interface ProtectedPdfSource {
  kind: "protected";
  length: number;
  initialData: Uint8Array;
  transport: ProtectedPdfRangeTransport;
}

export interface PlainPdfSource {
  kind: "plain";
  length: number;
  initialData: Uint8Array;
  transport: PlainPdfRangeTransport;
}

export type PdfSource = ProtectedPdfSource | PlainPdfSource;

export interface PdfDownloadBytes {
  bytes: Uint8Array;
  protected: boolean;
}

function maskByteAt(position: number): number {
  let x = (position + 0x9e3779b9) ^ MASK_SEED;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) & 0xff;
}

export function applyPdfByteMask(bytes: Uint8Array, offset = 0): Uint8Array {
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = (bytes[i] ?? 0) ^ maskByteAt(offset + i);
  }
  return bytes;
}

export function maskPdfBytes(bytes: Uint8Array, offset = 0): Uint8Array {
  return applyPdfByteMask(new Uint8Array(bytes), offset);
}

export const protectPdfBytes = maskPdfBytes;
export const unprotectPdfBytes = maskPdfBytes;

export function hasPdfMagic(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_MAGIC.length) return false;
  for (let i = 0; i < PDF_MAGIC.length; i += 1) {
    if (bytes[i] !== PDF_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

export function parseContentRangeTotal(value: string | null): number | null {
  if (!value) return null;
  const match = /^bytes\s+\d+-\d+\/(\d+|\*)$/i.exec(value.trim());
  if (!match || match[1] === "*") return null;
  const total = Number(match[1]);
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}

interface ParsedContentRange {
  begin: number;
  end: number;
  total: number | null;
}

function parseContentRange(value: string | null): ParsedContentRange | null {
  if (!value) return null;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value.trim());
  if (!match) return null;

  const begin = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === "*" ? null : Number(match[3]);
  if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end < begin) return null;
  if (total !== null && (!Number.isSafeInteger(total) || total <= end)) return null;
  return { begin, end, total };
}

function parseContentLength(value: string | null): number | null {
  if (!value) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}

function getFetch(options: ProtectedPdfFetchOptions): typeof fetch {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  if (!fetchFn) {
    throw new Error("fetch is required to load protected PDFs");
  }
  return fetchFn;
}

function buildRangeHeaders(headers: HeadersInit | undefined, begin: number, end: number): HeadersInit {
  const rangeHeader = `bytes=${begin}-${end - 1}`;

  if (!headers) {
    return { Range: rangeHeader };
  }

  if (Array.isArray(headers)) {
    return [...headers.filter(([key]) => key.toLowerCase() !== "range"), ["Range", rangeHeader]];
  }

  if (typeof headers.forEach === "function") {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
      if (key.toLowerCase() !== "range") result[key] = value;
    });
    result.Range = rangeHeader;
    return result;
  }

  return { ...headers, Range: rangeHeader };
}

async function fetchRange(
  url: string,
  begin: number,
  end: number,
  options: ProtectedPdfFetchOptions,
  signal?: AbortSignal
): Promise<{ bytes: Uint8Array; totalLength: number | null }> {
  const fetchFn = getFetch(options);
  const response = await fetchFn(url, {
    headers: buildRangeHeaders(options.headers, begin, end),
    signal,
    credentials: options.withCredentials ? "include" : "same-origin",
  });

  if (response.status !== 206) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 200) {
      throw new Error("PDF server ignored the Range header; refusing to download the complete file");
    }
    throw new Error(`PDF range request failed with HTTP ${response.status}`);
  }

  const contentRange = parseContentRange(response.headers.get("Content-Range"));
  const expectedEnd = contentRange?.total === null ? null : Math.min(end, contentRange?.total ?? end) - 1;
  if (
    !contentRange ||
    contentRange.begin !== begin ||
    contentRange.end >= end ||
    (expectedEnd !== null && contentRange.end !== expectedEnd)
  ) {
    await response.body?.cancel().catch(() => {});
    throw new Error("PDF range response has an invalid Content-Range header");
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== contentRange.end - contentRange.begin + 1) {
    throw new Error("PDF range response length does not match Content-Range");
  }

  return { bytes, totalLength: contentRange.total };
}

function getRangeChunkSize(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : DEFAULT_PDF_RANGE_CHUNK_SIZE;
}

function getDownloadConcurrency(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) return DEFAULT_PDF_DOWNLOAD_CONCURRENCY;
  return Math.min(value!, 8);
}

async function fetchHeadLength(
  url: string,
  options: ProtectedPdfFetchOptions,
  signal?: AbortSignal
): Promise<number | null> {
  const fetchFn = getFetch(options);
  const response = await fetchFn(url, {
    method: "HEAD",
    headers: options.headers,
    credentials: options.withCredentials ? "include" : "same-origin",
    signal,
  });
  if (!response.ok) return null;
  return parseContentLength(response.headers.get("Content-Length"));
}

async function resolveTotalLength(
  url: string,
  rangeResult: Awaited<ReturnType<typeof fetchRange>>,
  options: ProtectedPdfFetchOptions,
  signal?: AbortSignal
): Promise<number> {
  if (rangeResult.totalLength !== null) return rangeResult.totalLength;

  const headLength = await fetchHeadLength(url, options, signal);
  if (headLength !== null) return headLength;

  throw new Error("PDF range loading requires Content-Range or HEAD Content-Length from the CDN");
}

async function fetchBytesByRanges(
  url: string,
  length: number,
  initialData: Uint8Array,
  rangeChunkSize: number,
  options: ProtectedPdfFetchOptions,
  signal: AbortSignal | undefined,
  transformChunk: (bytes: Uint8Array, begin: number) => Uint8Array,
  concurrency: number,
): Promise<Uint8Array> {
  const bytes = new Uint8Array(length);
  const initialLength = Math.min(initialData.length, length);
  bytes.set(initialData.slice(0, initialLength), 0);
  let loadedBytes = initialLength;
  options.onDownloadProgress?.(loadedBytes, length);

  const ranges: Array<{ begin: number; end: number }> = [];
  for (let begin = initialLength; begin < length; begin += rangeChunkSize) {
    ranges.push({ begin, end: Math.min(begin + rangeChunkSize, length) });
  }

  let nextRange = 0;
  const worker = async () => {
    while (nextRange < ranges.length) {
      const range = ranges[nextRange++];
      if (!range) return;

      const chunk = await fetchRange(url, range.begin, range.end, options, signal);
      bytes.set(transformChunk(chunk.bytes, range.begin), range.begin);
      loadedBytes += chunk.bytes.length;
      options.onDownloadProgress?.(Math.min(loadedBytes, length), length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, ranges.length) }, worker));

  return bytes;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

abstract class HttpPdfRangeTransport extends PDFDataRangeTransport {
  readonly url: string;

  readonly options: ProtectedPdfFetchOptions;

  readonly requestedRanges: Array<{ begin: number; end: number }> = [];

  private readonly controllers = new Set<AbortController>();

  private aborted = false;

  private failed = false;

  constructor(url: string, length: number, initialData: Uint8Array, options: ProtectedPdfFetchOptions = {}) {
    super(length, initialData, true);
    this.url = url;
    this.options = options;
  }

  protected abstract transformChunk(bytes: Uint8Array, begin: number): Uint8Array;

  requestDataRange(begin: number, end: number): void {
    if (this.aborted || this.failed) return;

    const controller = new AbortController();
    this.controllers.add(controller);
    this.requestedRanges.push({ begin, end });

    void fetchRange(this.url, begin, end, this.options, controller.signal)
      .then(({ bytes }) => {
        if (controller.signal.aborted) return;
        this.onDataRange(begin, this.transformChunk(bytes, begin));
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          this.failed = true;
          const rangeError = toError(error);
          this.options.onRangeError?.(rangeError);
          this.abort();
        }
      })
      .finally(() => {
        this.controllers.delete(controller);
      });
  }

  abort(): void {
    this.aborted = true;
    for (const controller of this.controllers) {
      controller.abort();
    }
    this.controllers.clear();
  }
}

export class ProtectedPdfRangeTransport extends HttpPdfRangeTransport {
  protected transformChunk(bytes: Uint8Array, begin: number): Uint8Array {
    return applyPdfByteMask(bytes, begin);
  }
}

export class PlainPdfRangeTransport extends HttpPdfRangeTransport {
  protected transformChunk(bytes: Uint8Array): Uint8Array {
    return bytes;
  }
}

export async function resolvePdfSource(
  url: string,
  mode: ProtectedPdfMode = "auto",
  options: ProtectedPdfFetchOptions = {},
  signal?: AbortSignal
): Promise<PdfSource> {
  const rangeChunkSize = getRangeChunkSize(options.rangeChunkSize);
  const initialRange = await fetchRange(url, 0, rangeChunkSize, options, signal);

  if (hasPdfMagic(initialRange.bytes)) {
    if (mode === true) {
      throw new Error("Expected a protected PDF, but the CDN returned a plain PDF");
    }
    const length = await resolveTotalLength(url, initialRange, options, signal);
    return {
      kind: "plain",
      length,
      initialData: initialRange.bytes,
      transport: new PlainPdfRangeTransport(url, length, initialRange.bytes, options),
    };
  }

  if (mode === false) {
    throw new Error("Expected a plain PDF, but the CDN returned a protected PDF");
  }

  const initialData = applyPdfByteMask(new Uint8Array(initialRange.bytes), 0);
  if (!hasPdfMagic(initialData)) {
    throw new Error("CDN file is neither a plain PDF nor a JOJO protected PDF");
  }
  const length = await resolveTotalLength(url, initialRange, options, signal);
  return {
    kind: "protected",
    length,
    initialData,
    transport: new ProtectedPdfRangeTransport(url, length, initialData, options),
  };
}

export async function fetchPdfDownloadBytes(
  url: string,
  mode: ProtectedPdfMode = "auto",
  options: ProtectedPdfFetchOptions = {},
  signal?: AbortSignal
): Promise<PdfDownloadBytes> {
  const rangeChunkSize = getRangeChunkSize(options.rangeChunkSize ?? DEFAULT_PDF_DOWNLOAD_RANGE_CHUNK_SIZE);
  const downloadConcurrency = getDownloadConcurrency(options.downloadConcurrency);
  const initialRange = await fetchRange(url, 0, rangeChunkSize, options, signal);

  if (hasPdfMagic(initialRange.bytes)) {
    if (mode === true) {
      throw new Error("Expected a protected PDF, but the CDN returned a plain PDF");
    }
    const length = await resolveTotalLength(url, initialRange, options, signal);
    return {
      bytes: await fetchBytesByRanges(
        url,
        length,
        initialRange.bytes,
        rangeChunkSize,
        options,
        signal,
        (bytes) => bytes,
        downloadConcurrency,
      ),
      protected: false,
    };
  }

  if (mode === false) {
    throw new Error("Expected a plain PDF, but the CDN returned a protected PDF");
  }

  const initialData = applyPdfByteMask(new Uint8Array(initialRange.bytes), 0);
  if (!hasPdfMagic(initialData)) {
    throw new Error("CDN file is neither a plain PDF nor a JOJO protected PDF");
  }
  const length = await resolveTotalLength(url, initialRange, options, signal);
  return {
    bytes: await fetchBytesByRanges(
      url,
      length,
      initialData,
      rangeChunkSize,
      options,
      signal,
      applyPdfByteMask,
      downloadConcurrency,
    ),
    protected: true,
  };
}
