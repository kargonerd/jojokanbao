import type { PageAvailabilityInput, UnavailablePageReason } from "../types.js";

export function unavailablePageReason(input: PageAvailabilityInput): UnavailablePageReason | undefined {
  if (input.hasFullBody) return undefined;
  let pathname = "";
  try {
    pathname = new URL(input.url).pathname;
  } catch {
    return undefined;
  }
  if (/\/(?:video|videos|gallery|galleries|picture|pictures)(?:\/|$)/iu.test(pathname)) return "UnsupportedMedia";
  return undefined;
}
