import type { SourceFetchPolicy } from "../../types.js";

export const dwFetch = {
  capture: "browser",
  bodySelectors: ["main article", "[itemprop='articleBody']", "article"],
} satisfies SourceFetchPolicy;
