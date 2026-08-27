import type { SourceFetchPolicy } from "../../types.js";

export const bloombergFetch = {
  capture: "browser",
  bodySelectors: ["article", "main"],
} satisfies SourceFetchPolicy;
