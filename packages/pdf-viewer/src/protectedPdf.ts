import { PDFDataRangeTransport } from "pdfjs-dist";

const PDF_MAGIC = "%PDF-";
const DEFAULT_RANGE_CHUNK_SIZE = 65536;
const MASK_SEED = 0x4a4f4a4f; // "JOJO"

export type ProtectedPdfMode = boolean | "auto";

export interface ProtectedPdfFetchOptions {
  fetchFn?: typeof fetch;
  headers?: HeadersInit;
  rangeChunkSize?: number;
  withCredentials?: boolean;
}

export interface ProtectedPdfSource {
  kind: "protected";
  length: number;
  initialData: Uint8Array;
  transport: ProtectedPdfRangeTransport;
}

export interface PlainPdfSource {
  kind: "plain";
  length: number | null;
  initialData?: Uint8Array;
  transport?: PlainPdfRangeTransport;
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
): Promise<{ bytes: Uint8Array; totalLength: number | null; status: number }> {
  const fetchFn = getFetch(options);
  const response = await fetchFn(url, {
    headers: buildRangeHeaders(options.headers, begin, end),
    signal,
    credentials: options.withCredentials ? "include" : "same-origin",
  });

  if (response.status !== 206 && response.status !== 200) {
    throw new Error(`PDF range request failed with HTTP ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const totalLength =
    parseContentRangeTotal(response.headers.get("Content-Range")) ??
    (response.status === 200 ? parseContentLength(response.headers.get("Content-Length")) : null);

  return { bytes, totalLength, status: response.status };
}

async function fetchHeadLength(url: string, options: ProtectedPdfFetchOptions): Promise<number | null> {
  const fetchFn = getFetch(options);
  const response = await fetchFn(url, {
    method: "HEAD",
    headers: options.headers,
    credentials: options.withCredentials ? "include" : "same-origin",
  });
  if (!response.ok) return null;
  return parseContentLength(response.headers.get("Content-Length"));
}

async function resolveTotalLength(
  url: string,
  rangeResult: Awaited<ReturnType<typeof fetchRange>>,
  options: ProtectedPdfFetchOptions
): Promise<number> {
  if (rangeResult.totalLength !== null) return rangeResult.totalLength;

  const headLength = await fetchHeadLength(url, options);
  if (headLength !== null) return headLength;

  throw new Error("Protected PDF loading requires Content-Range or HEAD Content-Length from the CDN");
}

async function fetchBytesByRanges(
  url: string,
  length: number,
  initialData: Uint8Array,
  rangeChunkSize: number,
  options: ProtectedPdfFetchOptions,
  signal: AbortSignal | undefined,
  transformChunk: (bytes: Uint8Array, begin: number) => Uint8Array
): Promise<Uint8Array> {
  const bytes = new Uint8Array(length);
  bytes.set(initialData.slice(0, Math.min(initialData.length, length)), 0);

  for (let begin = initialData.length; begin < length; begin += rangeChunkSize) {
    const end = Math.min(begin + rangeChunkSize, length);
    const chunk = await fetchRange(url, begin, end, options, signal);
    if (chunk.status !== 206) {
      throw new Error("CDN did not honor the requested byte range");
    }
    bytes.set(transformChunk(chunk.bytes, begin), begin);
  }

  return bytes;
}

export class ProtectedPdfRangeTransport extends PDFDataRangeTransport {
  readonly url: string;

  readonly options: ProtectedPdfFetchOptions;

  readonly requestedRanges: Array<{ begin: number; end: number }> = [];

  private readonly controllers = new Set<AbortController>();

  constructor(url: string, length: number, initialData: Uint8Array, options: ProtectedPdfFetchOptions = {}) {
    super(length, initialData, true);
    this.url = url;
    this.options = options;
  }

  requestDataRange(begin: number, end: number): void {
    const controller = new AbortController();
    this.controllers.add(controller);
    this.requestedRanges.push({ begin, end });

    fetchRange(this.url, begin, end, this.options, controller.signal)
      .then(({ bytes, status }) => {
        if (controller.signal.aborted) return;
        if (status !== 206) {
          throw new Error("CDN did not honor the requested byte range");
        }
        this.onDataRange(begin, applyPdfByteMask(bytes, begin));
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          console.error("Protected PDF range request failed", error);
        }
      })
      .finally(() => {
        this.controllers.delete(controller);
      });
  }

  abort(): void {
    for (const controller of this.controllers) {
      controller.abort();
    }
    this.controllers.clear();
  }
}

export class PlainPdfRangeTransport extends PDFDataRangeTransport {
  readonly url: string;

  readonly options: ProtectedPdfFetchOptions;

  readonly requestedRanges: Array<{ begin: number; end: number }> = [];

  private readonly controllers = new Set<AbortController>();

  constructor(url: string, length: number, initialData: Uint8Array, options: ProtectedPdfFetchOptions = {}) {
    super(length, initialData, true);
    this.url = url;
    this.options = options;
  }

  requestDataRange(begin: number, end: number): void {
    const controller = new AbortController();
    this.controllers.add(controller);
    this.requestedRanges.push({ begin, end });

    fetchRange(this.url, begin, end, this.options, controller.signal)
      .then(({ bytes, status }) => {
        if (controller.signal.aborted) return;
        if (status !== 206) {
          throw new Error("CDN did not honor the requested byte range");
        }
        this.onDataRange(begin, bytes);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          console.error("Plain PDF range request failed", error);
        }
      })
      .finally(() => {
        this.controllers.delete(controller);
      });
  }

  abort(): void {
    for (const controller of this.controllers) {
      controller.abort();
    }
    this.controllers.clear();
  }
}

export async function resolvePdfSource(
  url: string,
  mode: ProtectedPdfMode = "auto",
  options: ProtectedPdfFetchOptions = {}
): Promise<PdfSource> {
  const rangeChunkSize = options.rangeChunkSize ?? DEFAULT_RANGE_CHUNK_SIZE;
  const initialRange = await fetchRange(url, 0, rangeChunkSize, options);

  if (hasPdfMagic(initialRange.bytes)) {
    if (mode === true) {
      throw new Error("Expected a protected PDF, but the CDN returned a plain PDF");
    }
    if (initialRange.status !== 206) {
      throw new Error("PDF range loading requires CDN byte-range support");
    }
    const length = await resolveTotalLength(url, initialRange, options);
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
  if (initialRange.status !== 206) {
    throw new Error("Protected PDF loading requires CDN byte-range support");
  }

  const length = await resolveTotalLength(url, initialRange, options);
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
  const rangeChunkSize = options.rangeChunkSize ?? DEFAULT_RANGE_CHUNK_SIZE;
  const initialRange = await fetchRange(url, 0, rangeChunkSize, options, signal);

  if (hasPdfMagic(initialRange.bytes)) {
    if (mode === true) {
      throw new Error("Expected a protected PDF, but the CDN returned a plain PDF");
    }
    if (initialRange.status !== 206) {
      throw new Error("PDF download requires CDN byte-range support");
    }
    const length = await resolveTotalLength(url, initialRange, options);
    return {
      bytes: await fetchBytesByRanges(
        url,
        length,
        initialRange.bytes,
        rangeChunkSize,
        options,
        signal,
        (bytes) => bytes
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
  if (initialRange.status !== 206) {
    throw new Error("Protected PDF download requires CDN byte-range support");
  }

  const length = await resolveTotalLength(url, initialRange, options);
  return {
    bytes: await fetchBytesByRanges(url, length, initialData, rangeChunkSize, options, signal, applyPdfByteMask),
    protected: true,
  };
}
