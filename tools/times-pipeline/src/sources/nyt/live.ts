import type { Candidate } from "../../types.js";

export function isNytLiveUpdateUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!["nytimes.com", "www.nytimes.com"].includes(url.hostname)) return false;
    const segments = url.pathname.split("/").filter(Boolean);
    return segments[0] === "live"
      && /^\d{4}$/u.test(segments[1] ?? "")
      && /^\d{2}$/u.test(segments[2] ?? "")
      && /^\d{2}$/u.test(segments[3] ?? "")
      && segments.length > 6;
  } catch {
    return false;
  }
}

export function acceptNytUrl(value: string): boolean {
  return !isNytLiveUpdateUrl(value);
}

export function processNytCandidate(candidate: Candidate): Candidate {
  return isNytLiveUpdateUrl(candidate.canonicalUrl)
    ? { ...candidate, captureStatus: "duplicate" }
    : candidate;
}
