import type { SourceFetchPolicy } from "../../types.js";

export const bloombergFetch = {
  capture: "browser",
  bodySelectors: ["article", "main"],
  revision: "bloomberg-story-assets-v1",
} satisfies SourceFetchPolicy;
