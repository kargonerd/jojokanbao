import type { SourceFetchPolicy } from "../../types.js";

export const clsFetch = {
  capture: "http",
  bodySelectors: [".detail-content", ".article-content", "[itemprop='articleBody']", "article"],
  revision: "semantic-media-v3",
} satisfies SourceFetchPolicy;
