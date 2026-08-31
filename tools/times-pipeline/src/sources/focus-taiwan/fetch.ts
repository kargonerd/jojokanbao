import type { SourceFetchPolicy } from "../../types.js";

export const focusTaiwanFetch = {
  capture: "browser",
  bodySelectors: [".paragraph", ".article-content", "[itemprop='articleBody']"],
  revision: "semantic-media-v3",
} satisfies SourceFetchPolicy;
