import { downloadFile, uploadFiles } from "@huggingface/hub";
import { PROXY_CACHE_MAX_BYTES, PROXY_CACHE_OBJECT, type ProxyCacheStore } from "./proxy-subscription-cache.js";

const CACHE_IO_TIMEOUT_MS = 20_000;

/** Optional cache I/O must never consume the Runtime store's multi-minute retries. */
async function bounded<T>(operation: (fetcher: typeof fetch, signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("Proxy subscription cache unavailable")); }, CACHE_IO_TIMEOUT_MS);
  });
  const fetcher: typeof fetch = (input, init) => fetch(input, {
    ...init,
    signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : []),
      ...(input instanceof Request ? [input.signal] : [])]),
  });
  try {
    return await Promise.race([operation(fetcher, controller.signal), timeout]);
  } catch {
    // HF errors can contain signed URLs and headers. Do not propagate them.
    throw new Error("Proxy subscription cache unavailable");
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export function hfProxyCacheStore(bucket: string, accessToken: string): ProxyCacheStore {
  const name = bucket.trim().replace(/^buckets\//u, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name) || !accessToken.trim()) {
    throw new Error("Proxy subscription cache configuration is invalid");
  }
  const repo = { type: "bucket" as const, name };
  const read = async (fetcher: typeof fetch): Promise<string | null> => {
    const blob = await downloadFile({ repo, accessToken, path: PROXY_CACHE_OBJECT, fetch: fetcher, xet: false });
    if (!blob) return null;
    if (!Number.isSafeInteger(blob.size) || blob.size < 0 || blob.size > PROXY_CACHE_MAX_BYTES) throw new Error();
    const reader = blob.stream().getReader();
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > PROXY_CACHE_MAX_BYTES) throw new Error();
        chunks.push(value);
      }
      if (size !== blob.size) throw new Error();
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  };
  return {
    read: () => bounded(read),
    write: (encrypted) => bounded(async (fetcher, signal) => {
      if (Buffer.byteLength(encrypted) > PROXY_CACHE_MAX_BYTES) throw new Error();
      await uploadFiles({ repo, accessToken,
        files: [{ path: PROXY_CACHE_OBJECT, content: new Blob([encrypted]) }],
        fetch: fetcher, abortSignal: signal, useWebWorkers: false, useXet: true,
      });
      // Bucket batch uploads can report per-file failures without rejecting.
      // Verify exact ciphertext under the SAME 20-second write deadline.
      if (await read(fetcher) !== encrypted) throw new Error();
    }),
  };
}
