import type { SourceFetchPolicy } from "../../types.js";

export const clsFetch = {
  capture: "browser",
  bodySelectors: [".detail-content", ".article-content", "[itemprop='articleBody']", "article"],
} satisfies SourceFetchPolicy;
