import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseProxySubscription, serializeMihomoConfig } from "./proxy-config.js";
import { downloadSubscription, SubscriptionDownloadError, type SubscriptionFailure } from "./proxy-subscription.js";
import {
  decryptProxyCache, encryptProxyCache, PROXY_CACHE_MAX_BYTES, PROXY_CACHE_REFRESH_MS,
  ProxyCacheRejected, type ProxyCache,
} from "./proxy-subscription-cache.js";

export interface ProxyPreparationOptions {
  url: string;
  output: string;
  cache?: ProxyCache;
  now?: () => number;
  download?: typeof downloadSubscription;
}

export interface ProxyPreparationReport {
  source: "live" | "cache";
  nodes: number;
  cacheAgeSeconds?: number;
  failure?: SubscriptionFailure;
}

const candidatePath = (output: string): string => `${output}.last-known-good.enc.json`;
const log = (message: string): void => { process.stderr.write(`[proxy] ${message}\n`); };

async function privateFile(file: string, value: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, value, { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
}

export async function prepareProxyConfiguration(options: ProxyPreparationOptions): Promise<ProxyPreparationReport> {
  const { url, output, cache } = options;
  const now = options.now ?? Date.now;
  // Never accidentally commit a previous invocation's candidate after failure or fallback.
  await rm(candidatePath(output), { force: true });
  let text: string;
  try {
    text = await (options.download ?? downloadSubscription)(url);
  } catch (error) {
    if (!(error instanceof SubscriptionDownloadError) || !error.failure.retryable || !cache) throw error;
    try {
      const cached = decryptProxyCache(await cache.store.read(), cache.secret, url, now());
      const subscription = parseProxySubscription(cached.config);
      await privateFile(output, serializeMihomoConfig(subscription));
      const report: ProxyPreparationReport = { source: "cache", nodes: subscription.proxies.length,
        cacheAgeSeconds: Math.floor((now() - cached.fetchedAt) / 1_000), failure: error.failure };
      log(`subscription_cache_fallback ${JSON.stringify(report)}`);
      return report;
    } catch (cacheError) {
      const reason = cacheError instanceof ProxyCacheRejected ? cacheError.reason : "unavailable";
      log(`subscription_cache_rejected ${JSON.stringify({ reason })}`);
      throw error;
    }
  }
  // Invalid YAML / empty nodes / reserved names are not transient transport errors.
  const subscription = parseProxySubscription(text);
  const config = serializeMihomoConfig(subscription);
  await privateFile(output, config);
  if (cache) {
    try {
      await privateFile(candidatePath(output), encryptProxyCache({ config, fetchedAt: now() }, cache.secret, url));
    } catch {
      log("subscription_cache_stage_failed"); // A healthy live subscription must still work.
    }
  }
  return { source: "live", nodes: subscription.proxies.length };
}

/** Call only after the exact prepared configuration passes the local proxy probe. */
export async function commitHealthyProxyCache(options: ProxyPreparationOptions): Promise<void> {
  const { cache, url, output } = options;
  if (!cache) return;
  const candidate = candidatePath(output);
  try {
    const info = await stat(candidate).catch(() => null);
    if (!info) return; // Cached fallbacks never extend their own expiry.
    if (info.size > PROXY_CACHE_MAX_BYTES) throw new Error();
    const encrypted = await readFile(candidate, "utf8");
    const now = (options.now ?? Date.now)();
    const prepared = decryptProxyCache(encrypted, cache.secret, url, now);
    if (prepared.config !== await readFile(output, "utf8")) throw new Error();
    try {
      const current = decryptProxyCache(await cache.store.read(), cache.secret, url, now);
      if (current.config === prepared.config && now - current.fetchedAt < PROXY_CACHE_REFRESH_MS) return;
    } catch { /* Missing, expired or unreadable cache can be replaced by a healthy live result. */ }
    await cache.store.write(encrypted);
    log("subscription_cache_saved");
  } catch {
    log("subscription_cache_save_failed");
  } finally {
    await rm(candidate, { force: true });
  }
}
