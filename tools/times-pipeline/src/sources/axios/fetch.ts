import type { SourceFetchPolicy } from "../../types.js";

export const axiosFetch = {
  capture: "browser",
  bodySelectors: [".gtm-story-text","[data-testid='story-body']","article"],
  revision: "axios-story-assets-v1",
} satisfies SourceFetchPolicy;
