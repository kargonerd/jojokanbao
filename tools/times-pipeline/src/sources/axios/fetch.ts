import type { SourceFetchPolicy } from "../../types.js";

export const axiosFetch = {
  capture: "browser",
  bodySelectors: ["[data-cy='story-body']", ".gtm-story-text", "[data-testid='story-body']"],
  revision: "axios-story-assets-v2",
} satisfies SourceFetchPolicy;
