import { fileURLToPath } from "node:url";
import path from "node:path";

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${name ?? "end"}`);
    values[name.slice(2)] = value;
  }
  return values;
}

export function catalogCacheIsSafe(cacheControl) {
  if (!cacheControl) return false;
  const normalized = cacheControl.toLowerCase();
  if (normalized.includes("no-cache") || normalized.includes("no-store")) return true;
  const lifetimes = [...normalized.matchAll(/(?:s-maxage|max-age)\s*=\s*(\d+)/g)]
    .map((match) => Number(match[1]));
  return lifetimes.length > 0 && lifetimes.every((seconds) => seconds <= 300);
}

export function corsAllowsOrigin(value, origin) {
  if (!value) return false;
  return value.split(",").map((item) => item.trim()).some((item) => item === "*" || item === origin);
}

export async function verifyReleaseCdn({ catalogUrl, version, origin, fetchImpl = fetch }) {
  const url = new URL(catalogUrl);
  if (url.protocol !== "https:") throw new Error("Release catalogs must use HTTPS");
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/json",
      "Cache-Control": "no-cache",
      Origin: origin,
    },
  });
  if (!response.ok) throw new Error(`CDN catalog returned HTTP ${response.status}`);
  if (!corsAllowsOrigin(response.headers.get("access-control-allow-origin"), origin)) {
    throw new Error(`CDN catalog does not allow browser reads from ${origin}`);
  }
  const cacheControl = response.headers.get("cache-control");
  if (!catalogCacheIsSafe(cacheControl)) {
    throw new Error(`CDN catalog cache policy is missing or too long: ${cacheControl ?? "none"}`);
  }
  const catalog = await response.json();
  if (catalog?.version !== version) throw new Error(`Expected catalog ${version}, received ${catalog?.version ?? "invalid JSON"}`);
  if (!Array.isArray(catalog.artifacts) || !catalog.artifacts.length) throw new Error("CDN catalog has no artifacts");
  for (const artifact of catalog.artifacts) {
    if (new URL(artifact.url).protocol !== "https:") throw new Error(`Artifact ${artifact.id ?? "unknown"} does not use HTTPS`);
  }
  return catalog;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (!args.catalog || !args.version || !args.origin) throw new Error("--catalog, --version, and --origin are required");
  await verifyReleaseCdn({ catalogUrl: args.catalog, version: args.version, origin: args.origin });
  process.stdout.write(`Verified release catalog ${args.version} at ${args.catalog}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
