import type { PageAvailabilityInput, UnavailablePageReason } from "../../types.js";

export function classifyNprUnavailablePage(input: PageAvailabilityInput): UnavailablePageReason | undefined {
  if (input.hasFullBody) return undefined;
  return /\bno-transcript\b/iu.test(input.html ?? "") ? "UnsupportedMedia" : undefined;
}
