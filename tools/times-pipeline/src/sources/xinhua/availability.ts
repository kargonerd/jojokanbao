import type {
  PageAvailabilityInput,
  SourceConfig,
  UnavailablePageReason,
} from "../../types.js";
import { isXinhuaVideoOnlyPage } from "./discover.js";

export function classifyXinhuaUnavailablePage(
  input: PageAvailabilityInput,
  source: SourceConfig,
): UnavailablePageReason | undefined {
  if (input.hasFullBody || !input.html) return undefined;
  return isXinhuaVideoOnlyPage(input.html, source) ? "UnsupportedMedia" : undefined;
}
