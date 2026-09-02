import type { PageAvailabilityInput, UnavailablePageReason } from "../../types.js";
import { isPeopleVideoPage } from "./process.js";

export function classifyPeopleUnavailablePage(input: PageAvailabilityInput): UnavailablePageReason | undefined {
  if (input.hasFullBody || !input.html) return undefined;
  return isPeopleVideoPage(input.html) ? "UnsupportedMedia" : undefined;
}
