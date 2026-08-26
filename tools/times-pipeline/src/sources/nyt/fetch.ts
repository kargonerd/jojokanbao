import type { SourceFetchPolicy } from "../../types.js";

export const nytFetch = {
  capture: "browser",
  bodySelectors: ["section[name='articleBody']","#story","article"],
} satisfies SourceFetchPolicy;
