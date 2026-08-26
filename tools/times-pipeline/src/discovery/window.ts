import type { Candidate, DiscoveryResult } from "../types.js";

export interface DiscoveryWindowOptions {
  startedAt: string;
  sinceHours: number;
  futureToleranceSeconds: number;
}

export function filterDiscoveryWindow(
  candidates: Candidate[],
  options: DiscoveryWindowOptions,
): { candidates: Candidate[]; window: NonNullable<DiscoveryResult["window"]> } {
  const startedAt = new Date(options.startedAt).valueOf();
  if (!Number.isFinite(startedAt) || options.sinceHours <= 0 || options.futureToleranceSeconds < 0) {
    throw new Error("Discovery window options are invalid");
  }
  const start = startedAt - options.sinceHours * 3_600_000;
  const end = startedAt + options.futureToleranceSeconds * 1_000;
  let beforeWindow = 0;
  let afterWindow = 0;
  let invalidTimestamp = 0;
  const anomalies: NonNullable<DiscoveryResult["window"]>["anomalies"] = [];
  const accepted = candidates.filter((candidate) => {
    const publishedAt = new Date(candidate.publishedAt).valueOf();
    if (!Number.isFinite(publishedAt)) {
      invalidTimestamp += 1;
      anomalies.push({
        articleId: candidate.articleId,
        title: candidate.title,
        canonicalUrl: candidate.canonicalUrl,
        publishedAt: candidate.publishedAt,
        reason: "invalid-timestamp",
      });
      return false;
    }
    if (publishedAt < start) {
      beforeWindow += 1;
      return false;
    }
    if (publishedAt > end) {
      afterWindow += 1;
      anomalies.push({
        articleId: candidate.articleId,
        title: candidate.title,
        canonicalUrl: candidate.canonicalUrl,
        publishedAt: candidate.publishedAt,
        reason: "after-window",
      });
      return false;
    }
    return true;
  });
  return {
    candidates: accepted,
    window: {
      startInclusive: new Date(start).toISOString(),
      endInclusive: new Date(end).toISOString(),
      futureToleranceSeconds: options.futureToleranceSeconds,
      discovered: candidates.length,
      accepted: accepted.length,
      beforeWindow,
      afterWindow,
      invalidTimestamp,
      anomalies,
    },
  };
}
