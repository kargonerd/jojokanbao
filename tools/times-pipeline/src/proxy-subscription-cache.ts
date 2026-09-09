import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { MAXIMUM_SUBSCRIPTION_BYTES } from "./proxy-subscription.js";

export const PROXY_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const PROXY_CACHE_REFRESH_MS = 12 * 60 * 60 * 1_000;
export const PROXY_CACHE_MAX_BYTES = 28_000_000;
const CONTEXT = "jojo-times-proxy-cache/v1";

/** Stable across list reordering; never expose URLs or publicly computable URL hashes. */
export function proxyCacheObject(url: string, secret: string): string {
  if (!url.trim() || !secret.trim()) throw new ProxyCacheRejected("invalid");
  const id = createHmac("sha256", secret).update("jojo-times-proxy-cache-object/v1\0").update(url).digest("hex");
  return `times/proxy/subscriptions/${id}.v1.json`;
}

export interface ProxyCacheStore {
  read(): Promise<string | null>;
  write(encrypted: string): Promise<void>;
}

export interface ProxyCache {
  store: ProxyCacheStore;
  secret: string;
}

export interface CachedProxy {
  fetchedAt: number;
  config: string;
}

export class ProxyCacheRejected extends Error {
  constructor(readonly reason: "missing" | "invalid" | "expired") {
    super(`Proxy subscription cache ${reason}`);
  }
}

function key(secret: string, url: string): Buffer {
  if (!secret.trim() || !url.trim()) throw new ProxyCacheRejected("invalid");
  // Existing HF token supplies the secret; changing it OR the subscription URL
  // invalidates the ciphertext. No secret or raw URL is persisted.
  return Buffer.from(hkdfSync("sha256", secret, url, CONTEXT, 32));
}

export function encryptProxyCache(value: CachedProxy, secret: string, url: string): string {
  if (!Number.isSafeInteger(value.fetchedAt) || value.fetchedAt < 0
    || Buffer.byteLength(value.config) > MAXIMUM_SUBSCRIPTION_BYTES) throw new ProxyCacheRejected("invalid");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret, url), iv);
  cipher.setAAD(Buffer.from(CONTEXT));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const encrypted = JSON.stringify({ version: 1, iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") });
  if (Buffer.byteLength(encrypted) > PROXY_CACHE_MAX_BYTES) throw new ProxyCacheRejected("invalid");
  return encrypted;
}

export function decryptProxyCache(encrypted: string | null, secret: string, url: string, now: number): CachedProxy {
  if (encrypted === null) throw new ProxyCacheRejected("missing");
  try {
    if (Buffer.byteLength(encrypted) > PROXY_CACHE_MAX_BYTES || !Number.isSafeInteger(now)) throw new Error();
    const record = JSON.parse(encrypted);
    if (record?.version !== 1 || ![record.iv, record.tag, record.ciphertext].every((v) => typeof v === "string")) {
      throw new Error();
    }
    const iv = Buffer.from(record.iv, "base64");
    const tag = Buffer.from(record.tag, "base64");
    if (iv.length !== 12 || tag.length !== 16) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key(secret, url), iv);
    decipher.setAAD(Buffer.from(CONTEXT));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]);
    const value = JSON.parse(plaintext.toString("utf8"));
    if (!Number.isSafeInteger(value?.fetchedAt) || value.fetchedAt < 0 || value.fetchedAt > now
      || typeof value.config !== "string" || Buffer.byteLength(value.config) > MAXIMUM_SUBSCRIPTION_BYTES) throw new Error();
    if (now - value.fetchedAt >= PROXY_CACHE_MAX_AGE_MS) throw new ProxyCacheRejected("expired");
    return { config: value.config, fetchedAt: value.fetchedAt };
  } catch (error) {
    if (error instanceof ProxyCacheRejected) throw error;
    throw new ProxyCacheRejected("invalid");
  }
}
