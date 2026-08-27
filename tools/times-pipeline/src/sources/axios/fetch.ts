import type { SourceFetchPolicy } from "../../types.js";

export const axiosFetch = {
  capture: "browser",
  bodySelectors: [".gtm-story-text","[data-testid='story-body']","article"],
} satisfies SourceFetchPolicy;
