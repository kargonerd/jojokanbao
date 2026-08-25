import { execFile } from "node:child_process";
import { request as httpRequest } from "node:http";
import { promisify } from "node:util";
import { articleId, normalizeArticleUrl } from "../../identity.js";
import type { DiscoveryResult, SourceConfig } from "../../types.js";
import type { SourceAdapterEndpoint } from "../contracts.js";

const ROOT = "https://www.bloomberg.com";
const BROWSER_USER_AGENT = "Mozilla/5.0";
const execFileAsync = promisify(execFile);

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function string(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized || undefined;
}

function message(value: unknown): string | undefined {
  return string(value) ?? string(object(value)?.text);
}

function articleUrl(value: unknown): string | undefined {
  const raw = string(value);
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw, ROOT);
  } catch {
    return undefined;
  }
  if (url.hostname !== "www.bloomberg.com" || !/^\/news\/(?:articles|features)\//u.test(url.pathname)) return undefined;
  return url.href;
}

async function localControlJson(
  controlUrl: string,
  path: string,
  method = "GET",
  payload?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const target = new URL(path, controlUrl);
  if (!new Set(["127.0.0.1", "localhost", "[::1]"]).has(target.hostname)) {
    throw new Error("Proxy control must be loopback-only");
  }
  const body = payload ? JSON.stringify(payload) : undefined;
  return new Promise((resolve, reject) => {
    const request = httpRequest(target, {
      method,
      headers: body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {},
      timeout: 5_000,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error("Proxy control request failed"));
          return;
        }
        if (chunks.length === 0) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        } catch {
          reject(new Error("Proxy control returned invalid JSON"));
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("Proxy control timed out")));
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

function routeCandidates(
  route: Record<string, unknown>,
  automatic: Record<string, unknown>,
  proxies: Record<string, unknown>,
  automaticName: string,
  maximum = 12,
): string[] {
  const all = Array.isArray(route.all) ? route.all.filter((value): value is string => typeof value === "string") : [];
  const excluded = new Set([automaticName, string(route.now), string(automatic.now)].filter((value): value is string => Boolean(value)));
  const proxyRows = object(proxies.proxies) ?? {};
  const delay = (name: string): number | undefined => {
    const history = object(proxyRows[name])?.history;
    if (!Array.isArray(history)) return undefined;
    return history.map((row) => object(row)?.delay).filter((value): value is number => typeof value === "number" && value > 0).at(-1);
  };
  const available = all.filter((name) => !excluded.has(name));
  const healthy = available.filter((name) => delay(name) !== undefined);
  const pool = (healthy.length ? healthy : available).sort((left, right) => (delay(left) ?? 2 ** 31) - (delay(right) ?? 2 ** 31));
  if (pool.length <= maximum) return pool;
  const selected = pool.slice(0, Math.min(3, maximum));
  for (let index = 0; selected.length < maximum && index < pool.length; index += 1) {
    const position = Math.round((index + 1) * (pool.length - 1) / (maximum + 1));
    const candidate = pool[position];
    if (candidate && !selected.includes(candidate)) selected.push(candidate);
  }
  return selected.slice(0, maximum);
}

async function curlJson(url: URL, proxyUri?: string): Promise<unknown> {
  const args = [
    "--fail-with-body",
    "--location",
    "--silent",
    "--show-error",
    "--max-time", "30",
    "--user-agent", BROWSER_USER_AGENT,
    "--header", "Accept: application/json, text/plain, */*",
  ];
  if (proxyUri) args.push("--proxy", proxyUri);
  args.push(url.href);
  const result = await execFileAsync("curl", args, {
    encoding: "utf8",
    maxBuffer: 5_000_000,
    timeout: 35_000,
    windowsHide: true,
  });
  return JSON.parse(result.stdout) as unknown;
}

async function curlJsonWithRotation(url: URL): Promise<unknown> {
  const proxyUri = process.env.JOJO_TIMES_PROXY_URI?.trim();
  try {
    return await curlJson(url, proxyUri);
  } catch {
    // Continue with isolated node retries when a local Mihomo controller is available.
  }
  const controlUrl = process.env.JOJO_TIMES_PROXY_CONTROL_URL?.trim();
  if (!proxyUri || !controlUrl) throw new Error("No discovery proxy rotation is configured");
  const routeGroup = "JOJO-TIMES-ROUTE";
  const automaticName = "JOJO-TIMES-AUTO";
  const [route, automatic, proxies] = await Promise.all([
    localControlJson(controlUrl, `/proxies/${encodeURIComponent(routeGroup)}`),
    localControlJson(controlUrl, `/proxies/${encodeURIComponent(automaticName)}`),
    localControlJson(controlUrl, "/proxies"),
  ]);
  try {
    for (const name of routeCandidates(route, automatic, proxies, automaticName)) {
      await localControlJson(controlUrl, `/proxies/${encodeURIComponent(routeGroup)}`, "PUT", { name });
      try {
        return await curlJson(url, proxyUri);
      } catch {
        // Node names are intentionally never logged or persisted.
      }
    }
  } finally {
    await localControlJson(controlUrl, `/proxies/${encodeURIComponent(routeGroup)}`, "PUT", { name: automaticName });
  }
  throw new Error("All discovery proxy routes failed");
}

async function fetchLineup(url: URL, sourceId: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json, text/plain, */*",
      "accept-language": "en-US,en;q=0.9",
      referer: `${ROOT}/`,
      "user-agent": BROWSER_USER_AGENT,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.ok) return response.json();
  if (response.status !== 401 && response.status !== 403) {
    throw new Error(`${sourceId}: Bloomberg lineup returned HTTP ${response.status}`);
  }

  // Bloomberg rejects Node's TLS fingerprint on this otherwise public JSON endpoint.
  // curl remains lightweight; proxy retries are isolated to this serial source worker.
  try {
    return await curlJsonWithRotation(url);
  } catch {
    throw new Error(`${sourceId}: Bloomberg lineup HTTP fallback failed`);
  }
}

export async function discoverBloomberg(
  source: SourceConfig,
  endpoint: SourceAdapterEndpoint,
  fetchedAt: string,
): Promise<DiscoveryResult> {
  if (endpoint.adapter !== "bloomberg") throw new Error(`${source.id}: expected Bloomberg adapter`);
  const url = new URL(`/lineup-next/api/page/${endpoint.pageId}/module/${endpoint.moduleIds.join(",")}`, ROOT);
  url.searchParams.set("moduleVariations", "default");
  url.searchParams.set("moduleTypes", "lineup_content");
  url.searchParams.set("locale", "en");
  url.searchParams.set("publishedState", "PUBLISHED");
  const upstream = await fetchLineup(url, source.id);
  const modules = object(upstream) ?? {};
  const candidates = new Map<string, DiscoveryResult["candidates"][number]>();

  for (const module of Object.values(modules)) {
    const items = object(module)?.items;
    if (!Array.isArray(items)) continue;
    for (const value of items) {
      const row = object(value);
      const sourceUrl = articleUrl(row?.url);
      const title = message(row?.headline);
      const publishedAt = string(row?.publishedAt);
      if (!sourceUrl || !title || !publishedAt || Number.isNaN(new Date(publishedAt).valueOf())) continue;
      const canonicalUrl = normalizeArticleUrl(sourceUrl);
      const summary = message(row?.summary) ?? message(row?.description);
      const upstreamId = string(row?.id);
      const categories = [message(row?.brand), message(row?.franchise), message(object(row?.eyebrow)?.text)]
        .filter((category): category is string => Boolean(category));
      const candidate = {
        articleId: articleId(source.id, canonicalUrl),
        sourceId: source.id,
        sourceName: source.name,
        language: source.language,
        sourceUrl,
        canonicalUrl,
        title,
        ...(summary ? { summary } : {}),
        contentStatus: summary ? "summary" as const : "metadata" as const,
        publishedAt: new Date(publishedAt).toISOString(),
        authors: string(row?.byline) ? [string(row?.byline) as string] : [],
        publisherCategories: [...new Set(categories)],
        ...(upstreamId ? { upstreamId } : {}),
      };
      candidates.set(candidate.articleId, candidate);
      if (candidates.size >= endpoint.maximumItems) break;
    }
    if (candidates.size >= endpoint.maximumItems) break;
  }

  return {
    source,
    transport: "source-adapter",
    fetchedAt,
    upstream: { url: url.href, modules: upstream },
    candidates: [...candidates.values()],
  };
}
