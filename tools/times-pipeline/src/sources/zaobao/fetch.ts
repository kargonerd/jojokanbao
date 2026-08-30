import type { SourceFetchPolicy } from "../../types.js";

export const zaobaoFetch = {
  capture: "browser",
  bodySelectors: [".articleBody", ".article-content", ".article-body", "article"],
  revision: "semantic-media-v3",
} satisfies SourceFetchPolicy;
