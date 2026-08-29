import type { PageAvailabilityInput, UnavailablePageReason } from "../../types.js";
import { nikkeiArticleAccess } from "./process.js";

export function classifyNikkeiUnavailablePage(input: PageAvailabilityInput): UnavailablePageReason | undefined {
  if (input.hasFullBody || !input.html) return undefined;
  return nikkeiArticleAccess(input.html) === false ? "HardPaywall" : undefined;
}
