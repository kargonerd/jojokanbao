#!/usr/bin/env node
import crypto from "node:crypto";

const SERVICE = "teo";
const VERSION = "2022-09-01";
const ACTION = "CreatePurgeTask";
const DEFAULT_ENDPOINT = process.env.EDGEONE_ENDPOINT ?? "teo.tencentcloudapi.com";

function usage() {
  console.log(`Usage:
  node tooling/purge-edgeone-reader-cache.mjs --zone-id zone-xxx <url> [url...]

Environment:
  TENCENTCLOUD_SECRET_ID or TENCENT_SECRET_ID
  TENCENTCLOUD_SECRET_KEY or TENCENT_SECRET_KEY
  EDGEONE_ZONE_ID may be used instead of --zone-id
  EDGEONE_ENDPOINT may be used instead of --endpoint

This submits an EdgeOne CreatePurgeTask with Type=purge_url for the supplied URLs.
`);
}

function parseArgs(argv) {
  const urls = [];
  let endpoint = DEFAULT_ENDPOINT;
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
    if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    urls.push(arg);
  }

  if (!zoneId) throw new Error("--zone-id or EDGEONE_ZONE_ID is required");
  if (urls.length === 0) throw new Error("At least one URL is required");
  for (const url of urls) {
    if (!/^https?:\/\//i.test(url)) throw new Error(`Purge target must be an absolute URL: ${url}`);
  }
  return { endpoint, urls, zoneId };
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

function buildAuthorization({ endpoint, payload, secretId, secretKey, timestamp }) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${endpoint}\nx-tc-action:${ACTION.toLowerCase()}\n`;
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

async function main() {
  const { endpoint, urls, zoneId } = parseArgs(process.argv.slice(2));
  const { secretId, secretKey } = getCredential();
  const payload = JSON.stringify({
    Targets: urls,
    Type: "purge_url",
    ZoneId: zoneId,
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const authorization = buildAuthorization({ endpoint, payload, secretId, secretKey, timestamp });

  const response = await fetch(`https://${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json; charset=utf-8",
      Host: endpoint,
      "X-TC-Action": ACTION,
      "X-TC-Timestamp": String(timestamp),
      "X-TC-Version": VERSION,
    },
    body: payload,
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`EdgeOne purge failed with HTTP ${response.status}\n${body}`);
  }
  console.log(body);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
