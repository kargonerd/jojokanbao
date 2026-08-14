const JOX_SALT = 0x4a4f5831; // "JOX1"

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (const byte of utf8(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function maskByte(position: number, objectSeed: number): number {
  let value = ((position >>> 0) + 0x9e3779b9) ^ objectSeed ^ JOX_SALT;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return value & 0xff;
}

/** The transform is symmetric: applying it twice with the same key restores the input. */
export function transformJoxBytes(
  bytes: Uint8Array,
  objectKey: string,
  offset = 0,
): Uint8Array {
  const result = new Uint8Array(bytes.length);
  const seed = fnv1a(objectKey.replaceAll("\\", "/").replace(/^\/+/, ""));
  for (let index = 0; index < bytes.length; index += 1) {
    result[index] = bytes[index]! ^ maskByte(offset + index, seed);
  }
  return result;
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export async function gunzipJoxJson<T>(
  protectedBytes: Uint8Array,
  objectKey: string,
): Promise<T> {
  const compressed = transformJoxBytes(protectedBytes, objectKey);
  const stream = new Blob([compressed.slice().buffer]).stream().pipeThrough(
    new DecompressionStream("gzip"),
  );
  const decoded = await readStream(stream);
  return JSON.parse(new TextDecoder().decode(decoded)) as T;
}

export class JoxClient {
  readonly baseUrl: URL;
  private readonly fetchFn: typeof fetch;

  constructor(baseUrl: string | URL, fetchFn: typeof fetch = fetch) {
    const normalized = new URL(baseUrl);
    if (!normalized.pathname.endsWith("/")) normalized.pathname += "/";
    this.baseUrl = normalized;
    // Browser fetch is a branded function in some runtimes and fails when
    // invoked as `this.fetchFn(...)`; keep an unbound closure instead.
    this.fetchFn = (input, init) => fetchFn(input, init);
  }

  url(objectKey: string): URL {
    const normalized = objectKey.replaceAll("\\", "/").replace(/^\/+/, "");
    return new URL(normalized, this.baseUrl);
  }

  async fetchBytes(
    objectKey: string,
    signal?: AbortSignal,
    cache: RequestCache = "default",
  ): Promise<Uint8Array> {
    const response = await this.fetchFn(this.url(objectKey), { signal, cache });
    if (!response.ok) {
      throw new Error(`Jox object returned HTTP ${response.status}: ${objectKey}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async fetchJson<T>(
    objectKey: string,
    signal?: AbortSignal,
    cache: RequestCache = "default",
  ): Promise<T> {
    return gunzipJoxJson<T>(await this.fetchBytes(objectKey, signal, cache), objectKey);
  }

  async fetchDecodedBytes(
    objectKey: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    return transformJoxBytes(await this.fetchBytes(objectKey, signal), objectKey);
  }
}

export function resolveJoxObject(parentObject: string, childObject: string): string {
  if (childObject.startsWith("/")) {
    throw new Error("Jox object paths must be relative");
  }
  const base = new URL(parentObject.replaceAll("\\", "/"), "https://jox.invalid/");
  const resolved = new URL(childObject.replaceAll("\\", "/"), base);
  const key = decodeURIComponent(resolved.pathname.replace(/^\/+/, ""));
  if (key.startsWith("../") || key.includes("/../")) {
    throw new Error("Jox object path escapes the delivery root");
  }
  return key;
}
