import type { SourceFetchPolicy } from "../../types.js";

export const focusTaiwanFetch = {
  capture: "browser",
  bodySelectors: [".paragraph", ".article-content", "[itemprop='articleBody']"],
} satisfies SourceFetchPolicy;
