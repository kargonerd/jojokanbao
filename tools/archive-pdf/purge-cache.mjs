#!/usr/bin/env node
import crypto from "node:crypto";

const SERVICE = "teo";
const VERSION = "2022-09-01";
const DEFAULT_ENDPOINT = process.env.EDGEONE_ENDPOINT ?? "teo.tencentcloudapi.com";

function usage() {
  console.log(`Usage:
  pnpm purge:archive-pdf -- [--zone-id zone-xxx] [--type purge_url|purge_prefix] <target> [target...]

Options:
  --type <type>       purge_url (default) or purge_prefix.
  --method <method>   delete or invalidate. Used by purge_prefix.

Environment:
  TENCENTCLOUD_SECRET_ID or TENCENT_SECRET_ID
  TENCENTCLOUD_SECRET_KEY or TENCENT_SECRET_KEY
  EDGEONE_ZONE_ID may be used instead of --zone-id. If neither is supplied, the
  closest matching EdgeOne zone is discovered from the target URL hostname.
  EDGEONE_ENDPOINT may be used instead of --endpoint

This submits an EdgeOne CreatePurgeTask for the supplied URLs or prefixes.
`);
}

function parseArgs(argv) {
  const urls = [];
  let endpoint = DEFAULT_ENDPOINT;
  let method = null;
  let type = "purge_url";
  let zoneId = process.env.EDGEONE_ZONE_ID ?? null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--zone-id") {
      zoneId = argv[++i];
      continue;
    }
    if (arg === "--endpoint") {
      endpoint = argv[++i];
      continue;
    }
    if (arg === "--method") {
      method = argv[++i];
      continue;
    }
    if (arg === "--type") {
      type = argv[++i];
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    urls.push(arg);
  }

  if (!new Set(["purge_url", "purge_prefix"]).has(type)) {
    throw new Error("--type must be purge_url or purge_prefix");
  }
  if (method && !new Set(["delete", "invalidate"]).has(method)) {
    throw new Error("--method must be delete or invalidate");
  }
  if (method && type !== "purge_prefix") {
    throw new Error("--method is only supported with --type purge_prefix");
  }
  if (urls.length === 0) throw new Error("At least one purge target is required");
  for (const url of urls) {
    if (!/^https?:\/\//i.test(url)) throw new Error(`Purge target must be an absolute URL: ${url}`);
  }
  return { endpoint, method, type, urls, zoneId };
}

function sha256(value, encoding = "hex") {
  return crypto.createHash("sha256").update(value).digest(encoding);
}

function hmac(key, value, encoding) {
  return crypto.createHmac("sha256", key).update(value).digest(encoding);
}

function getCredential() {
  const secretId = process.env.TENCENTCLOUD_SECRET_ID ?? process.env.TENCENT_SECRET_ID;
  const secretKey = process.env.TENCENTCLOUD_SECRET_KEY ?? process.env.TENCENT_SECRET_KEY;
  if (!secretId || !secretKey) {
    throw new Error("Tencent Cloud credentials are required in TENCENTCLOUD_SECRET_ID/TENCENTCLOUD_SECRET_KEY");
  }
  return { secretId, secretKey };
}

function buildAuthorization({ action, endpoint, payload, secretId, secretKey, timestamp }) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${endpoint}\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = "content-type;host;x-tc-action";
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    sha256(payload),
  ].join("\n");

  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = ["TC3-HMAC-SHA256", String(timestamp), credentialScope, sha256(canonicalRequest)].join("\n");
  const secretDate = hmac(`TC3${secretKey}`, date);
  const secretService = hmac(secretDate, SERVICE);
  const secretSigning = hmac(secretService, "tc3_request");
  const signature = hmac(secretSigning, stringToSign, "hex");

  return `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

async function requestTencent({ action, credential, endpoint, payload }) {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const authorization = buildAuthorization({
    action,
    endpoint,
    payload: body,
    secretId: credential.secretId,
    secretKey: credential.secretKey,
    timestamp,
  });

  const response = await fetch(`https://${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json; charset=utf-8",
      Host: endpoint,
      "X-TC-Action": action,
      "X-TC-Timestamp": String(timestamp),
      "X-TC-Version": VERSION,
    },
    body,
  });

  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`EdgeOne ${action} failed with HTTP ${response.status}\n${responseBody}`);
  }
  const parsed = JSON.parse(responseBody);
  if (parsed.Response?.Error) {
    throw new Error(`EdgeOne ${action} failed: ${JSON.stringify(parsed.Response.Error)}`);
  }
  return parsed;
}

async function discoverZoneId({ credential, endpoint, urls }) {
  const result = await requestTencent({
    action: "DescribeZones",
    credential,
    endpoint,
    payload: { Limit: 100, Offset: 0 },
  });
  const hostnames = urls.map((url) => new URL(url).hostname.toLowerCase());
  const matches = (result.Response?.Zones ?? []).filter((zone) => {
    const zoneName = zone.ZoneName?.toLowerCase();
    return zoneName && hostnames.some((hostname) => hostname === zoneName || hostname.endsWith(`.${zoneName}`));
  });
  matches.sort((left, right) => right.ZoneName.length - left.ZoneName.length);
  if (matches.length === 0) {
    throw new Error(`No EdgeOne zone matches: ${hostnames.join(", ")}`);
  }
  const closestLength = matches[0].ZoneName.length;
  const closest = matches.filter((zone) => zone.ZoneName.length === closestLength);
  const closestNames = new Set(closest.map((zone) => zone.ZoneName.toLowerCase()));
  if (closestNames.size !== 1) {
    throw new Error(`Multiple EdgeOne zones match equally: ${closest.map((zone) => zone.ZoneName).join(", ")}`);
  }
  if (closest.length > 1) {
    console.warn(
      `EdgeOne returned duplicate records for ${closest[0].ZoneName}; using ${closest[0].ZoneId}`,
    );
  }
  console.log(`Discovered EdgeOne zone ${closest[0].ZoneName} (${closest[0].ZoneId})`);
  return closest[0].ZoneId;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const credential = getCredential();
  const zoneId = options.zoneId ?? await discoverZoneId({
    credential,
    endpoint: options.endpoint,
    urls: options.urls,
  });
  const result = await requestTencent({
    action: "CreatePurgeTask",
    credential,
    endpoint: options.endpoint,
    payload: {
      Targets: options.urls,
      Type: options.type,
      ZoneId: zoneId,
      ...(options.method ? { Method: options.method } : {}),
    },
  });
  console.log(JSON.stringify(result));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
