import type { SourcePagePolicy } from "../../types.js";

export const clsPage: SourcePagePolicy = {
  capture: "browser",
  bodySelectors: [".detail-content", ".article-content", "[itemprop='articleBody']", "article"],
};
