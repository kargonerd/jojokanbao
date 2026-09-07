import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commitHealthyProxyCache, prepareProxyConfiguration } from "../src/prepare-proxy.js";
import { parseProxySubscription, serializeMihomoConfig } from "../src/proxy-config.js";
import { SubscriptionDownloadError } from "../src/proxy-subscription.js";
import {
  decryptProxyCache, encryptProxyCache, PROXY_CACHE_MAX_AGE_MS, PROXY_CACHE_REFRESH_MS,
  type ProxyCacheStore,
} from "../src/proxy-subscription-cache.js";

const URL = "https://private.example/subscription?token=subscription-secret";
const SECRET = "hf_dummy_private_cache_key";
const NOW = Date.UTC(2026, 8, 7);
const YAML = "proxies:\n  - name: private-node\n    type: ss\n    server: private-server\n    port: 443\n    cipher: aes-128-gcm\n    password: node-password\n";
const CONFIG = serializeMihomoConfig(parseProxySubscription(YAML));
const networkFailure = () => new SubscriptionDownloadError({ kind: "network", networkCodes: ["ENOTFOUND"], retryable: true });
const directories: string[] = [];
beforeEach(() => { vi.spyOn(process.stderr, "write").mockReturnValue(true); });
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup(initial: string | null = null) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jojo-proxy-cache-test-"));
  directories.push(directory);
  let stored = initial;
  const store: ProxyCacheStore = {
    read: vi.fn(async () => stored),
    write: vi.fn(async (encrypted: string) => { stored = encrypted; }),
  };
  return {
    url: URL, output: path.join(directory, "mihomo", "config.yaml"),
    cache: { store, secret: SECRET }, now: () => NOW,
    download: vi.fn(async () => YAML),
  };
}

describe("authenticated proxy subscription cache", () => {
  it("encrypts node credentials and timestamp, uses fresh nonces, and binds the URL and existing HF secret", () => {
    const cached = { config: CONFIG, fetchedAt: NOW };
    const first = encryptProxyCache(cached, SECRET, URL);
    expect(first).not.toMatch(/private|node-password|subscription-secret|hf_dummy|fetchedAt/);
    expect(first).not.toEqual(encryptProxyCache(cached, SECRET, URL));
    expect(decryptProxyCache(first, SECRET, URL, NOW)).toEqual(cached);
    expect(() => decryptProxyCache(first, SECRET, `${URL}-rotated`, NOW)).toThrow("invalid");
    expect(() => decryptProxyCache(first, `${SECRET}-rotated`, URL, NOW)).toThrow("invalid");
    const tampered = JSON.parse(first);
    tampered.tag = Buffer.alloc(16).toString("base64");
    expect(() => decryptProxyCache(JSON.stringify(tampered), SECRET, URL, NOW)).toThrow("invalid");
  });

  it("rejects missing, malformed, oversized, expired and future-dated cache entries", () => {
    expect(() => decryptProxyCache(null, SECRET, URL, NOW)).toThrow("missing");
    for (const value of ["bad", "{}", "null", "x".repeat(28_000_001)]) {
      expect(() => decryptProxyCache(value, SECRET, URL, NOW)).toThrow("invalid");
    }
    expect(() => decryptProxyCache(encryptProxyCache({ config: CONFIG, fetchedAt: NOW }, SECRET, URL),
      SECRET, URL, NOW + PROXY_CACHE_MAX_AGE_MS)).toThrow("expired");
    expect(() => decryptProxyCache(encryptProxyCache({ config: CONFIG, fetchedAt: NOW + 1 }, SECRET, URL),
      SECRET, URL, NOW)).toThrow("invalid");
  });
});

describe("last-known-healthy subscription preparation", () => {
  it("stages ciphertext only, publishes only after health confirmation, and keeps files private", async () => {
    const options = await setup();
    expect(await prepareProxyConfiguration(options)).toEqual({ source: "live", nodes: 1 });
    expect(options.cache.store.read).not.toHaveBeenCalled();
    expect(options.cache.store.write).not.toHaveBeenCalled();
    const staged = await readFile(`${options.output}.last-known-good.enc.json`, "utf8");
    expect(staged).not.toMatch(/private|node-password|subscription-secret/);
    if (process.platform !== "win32") expect((await stat(options.output)).mode & 0o777).toBe(0o600);
    await commitHealthyProxyCache(options);
    expect(options.cache.store.write).toHaveBeenCalledExactlyOnceWith(staged);
    expect(await readFile(options.output, "utf8")).toEqual(CONFIG);
    await expect(stat(`${options.output}.last-known-good.enc.json`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses healthy cache after transient failure, records safe degradation, and never renews its lifetime", async () => {
    const encrypted = encryptProxyCache({ config: CONFIG, fetchedAt: NOW - 3_600_000 }, SECRET, URL);
    const options = await setup(encrypted);
    options.download.mockRejectedValue(networkFailure());
    expect(await prepareProxyConfiguration(options)).toEqual({ source: "cache", nodes: 1, cacheAgeSeconds: 3600,
      failure: { kind: "network", networkCodes: ["ENOTFOUND"], retryable: true } });
    await commitHealthyProxyCache(options);
    expect(options.cache.store.write).not.toHaveBeenCalled();
    expect(await options.cache.store.read()).toBe(encrypted);
    expect(JSON.stringify(vi.mocked(process.stderr.write).mock.calls)).not.toMatch(/private|password|subscription-secret/);
    options.now = () => NOW + PROXY_CACHE_MAX_AGE_MS;
    await expect(prepareProxyConfiguration(options)).rejects.toThrow("Unable to download");
  });

  it.each([401, 403, 404])("never falls back or accesses cached credentials after HTTP %s", async (httpStatus) => {
    const options = await setup(encryptProxyCache({ config: CONFIG, fetchedAt: NOW }, SECRET, URL));
    options.download.mockRejectedValue(new SubscriptionDownloadError({ kind: "http", httpStatus, networkCodes: [], retryable: false }));
    await expect(prepareProxyConfiguration(options)).rejects.toThrow("Unable to download");
    expect(options.cache.store.read).not.toHaveBeenCalled();
  });

  it.each(["{bad yaml", "proxies: []", "<html>error</html>", "proxies:\n  - name: JOJO-TIMES-AUTO"])
  ("does not fall back on a malformed live response: %s", async (yaml) => {
    const options = await setup();
    options.download.mockResolvedValue(yaml);
    await expect(prepareProxyConfiguration(options)).rejects.toThrow();
    expect(options.cache.store.read).not.toHaveBeenCalled();
    expect(options.cache.store.write).not.toHaveBeenCalled();
  });

  it.each([null, "broken", "expired", "wrong-url", "empty-nodes"])("fails closed with an unusable %s cache", async (kind) => {
    const entry = kind === "expired" ? encryptProxyCache({ config: CONFIG, fetchedAt: NOW - PROXY_CACHE_MAX_AGE_MS }, SECRET, URL)
      : kind === "wrong-url" ? encryptProxyCache({ config: CONFIG, fetchedAt: NOW }, SECRET, `${URL}-other`)
      : kind === "empty-nodes" ? encryptProxyCache({ config: "proxies: []", fetchedAt: NOW }, SECRET, URL) : kind;
    const options = await setup(entry);
    options.download.mockRejectedValue(networkFailure());
    await expect(prepareProxyConfiguration(options)).rejects.toThrow("Unable to download");
    expect(options.cache.store.write).not.toHaveBeenCalled();
  });

  it("keeps healthy live preparation working when optional cache storage fails without leaking SDK errors", async () => {
    const options = await setup();
    vi.mocked(options.cache.store.read).mockRejectedValue(new Error("https://private.example/signed?secret"));
    vi.mocked(options.cache.store.write).mockRejectedValue(new Error("Authorization: hf_dummy_private_cache_key"));
    await expect(prepareProxyConfiguration(options)).resolves.toMatchObject({ source: "live" });
    await expect(commitHealthyProxyCache(options)).resolves.toBeUndefined();
    expect(JSON.stringify(vi.mocked(process.stderr.write).mock.calls)).not.toMatch(/private|secret|Authorization/);
  });

  it("refreshes unchanged content at most hourly but immediately saves changed healthy content", async () => {
    const options = await setup(encryptProxyCache({ config: CONFIG, fetchedAt: NOW - 1 }, SECRET, URL));
    await prepareProxyConfiguration(options);
    await commitHealthyProxyCache(options);
    expect(options.cache.store.write).not.toHaveBeenCalled();
    options.now = () => NOW + PROXY_CACHE_REFRESH_MS;
    await prepareProxyConfiguration(options);
    await commitHealthyProxyCache(options);
    expect(options.cache.store.write).toHaveBeenCalledTimes(1);
    options.download.mockResolvedValue(YAML.replace("node-password", "new-password"));
    await prepareProxyConfiguration(options);
    await commitHealthyProxyCache(options);
    expect(options.cache.store.write).toHaveBeenCalledTimes(2);
  });

  it("never commits a stale candidate after failed preparation or a modified untested configuration", async () => {
    const options = await setup();
    await prepareProxyConfiguration(options);
    await writeFile(options.output, "different, untested configuration");
    await commitHealthyProxyCache(options);
    expect(options.cache.store.write).not.toHaveBeenCalled();
    await prepareProxyConfiguration(options);
    options.download.mockRejectedValue(networkFailure());
    await expect(prepareProxyConfiguration(options)).rejects.toThrow();
    await commitHealthyProxyCache(options);
    expect(options.cache.store.write).not.toHaveBeenCalled();
  });
});
