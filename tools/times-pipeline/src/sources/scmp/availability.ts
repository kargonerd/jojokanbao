import type { PageAvailabilityInput, UnavailablePageReason } from "../../types.js";

export function classifyScmpUnavailablePage(input: PageAvailabilityInput): UnavailablePageReason | undefined {
  if (input.hasFullBody) return undefined;
  return /SCMP Plus subscription is required for access/iu.test(input.html ?? "") ? "HardPaywall" : undefined;
}
