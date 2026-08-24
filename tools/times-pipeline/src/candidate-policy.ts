import type { Candidate, SourceConfig } from "./types.js";

const VIDEO_PATH = /\/(?:videos?|shipin)(?:\/|$)/i;

export function isCanonicalUrlAllowed(source: SourceConfig, canonicalUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(canonicalUrl);
  } catch {
    return false;
  }
  if (VIDEO_PATH.test(url.pathname)) return false;
  const allowedHostnames = source.content.allowedHostnames;
  if (allowedHostnames && !allowedHostnames.includes(url.hostname.toLowerCase())) return false;
  return !(source.content.excludedPathPrefixes ?? []).some((prefix) => url.pathname.startsWith(prefix));
}

export function isCandidateAllowed(source: SourceConfig, candidate: Candidate): boolean {
  return isCanonicalUrlAllowed(source, candidate.canonicalUrl);
}
