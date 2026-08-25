import { createHash } from "node:crypto";

const TRACKING_PARAMETERS = new Set([
  "fbclid", "gclid", "mc_cid", "mc_eid", "ref", "ref_src", "spm", "srnd", "utm_campaign", "utm_content",
  "utm_medium", "utm_source", "utm_term",
]);

export function normalizeArticleUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  const thepaperMobile = url.hostname === "m.thepaper.cn" ? url.pathname.match(/^\/detail\/(\d+)\/?$/u) : null;
  if (thepaperMobile?.[1]) {
    url.hostname = "www.thepaper.cn";
    url.pathname = `/newsDetail_forward_${thepaperMobile[1]}`;
  }
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMETERS.has(key.toLowerCase()) || key.toLowerCase().startsWith("utm_")) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

export function articleId(sourceId: string, canonicalUrl: string): string {
  const digest = createHash("sha256").update(sourceId).update("\0").update(canonicalUrl).digest("hex").slice(0, 24);
  return `${sourceId}:${digest}`;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
