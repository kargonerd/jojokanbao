import { gunzipSync, strFromU8 } from "fflate";
import { abortable, ResourceCache } from "./resource-cache";

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

export async function gunzipJoxJson<T>(
  protectedBytes: Uint8Array,
  objectKey: string,
): Promise<T> {
  const compressed = transformJoxBytes(protectedBytes, objectKey);
  return JSON.parse(strFromU8(gunzipSync(compressed))) as T;
}

export class JoxClient {
  readonly baseUrl: URL;
  private readonly fetchFn: typeof fetch;

  constructor(baseUrl: string | URL, fetchFn: typeof fetch = fetch, private cache?: ResourceCache) {
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
    revision?: string,
    timeoutMs = 20_000,
  ): Promise<Uint8Array> {
    if (signal?.aborted) throw new Error("读取已取消");
    const url = this.url(objectKey);
    if (revision) url.searchParams.set("v", revision);
    const load = async () => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout>;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("内容加载超时，请检查网络后重试")); }, timeoutMs);
      });
      try {
        return await Promise.race([deadline, (async () => {
          // Mutable indices/manifests must revalidate once our short cache TTL
          // expires, even if the CDN sends a multi-day browser max-age.
          const response = await this.fetchFn(url, {
            cache: this.cache && !revision && cache === "default" ? "no-cache" : cache,
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`Jox object returned HTTP ${response.status}: ${objectKey}`);
          return new Uint8Array(await response.arrayBuffer());
        })()]);
      } finally { clearTimeout(timer!); }
    };
    const ttl = revision ? 7 * 86400_000 : 300_000;
    const task = this.cache && cache !== "no-store"
      ? cache === "reload" ? this.cache.refresh(url.href, ttl, load) : this.cache.get(url.href, ttl, load)
      : load();
    return abortable(task, signal);
  }

  async fetchJson<T>(
    objectKey: string,
    signal?: AbortSignal,
    cache: RequestCache = "default",
    revision?: string,
  ): Promise<T> {
    const bytes = await this.fetchBytes(objectKey, signal, cache, revision);
    try { return await gunzipJoxJson<T>(bytes, objectKey); }
    catch (error) {
      const key = this.url(objectKey);
      if (revision) key.searchParams.set("v", revision);
      await this.cache?.delete(key.href);
      throw error;
    }
  }

  async fetchDecodedBytes(
    objectKey: string,
    signal?: AbortSignal,
    revision?: string,
    timeoutMs?: number,
  ): Promise<Uint8Array> {
    return transformJoxBytes(await this.fetchBytes(objectKey, signal, "default", revision, timeoutMs), objectKey);
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
