import type { SourcePagePolicy } from "../../types.js";

export const clsPage: SourcePagePolicy = {
  capture: "browser",
  bodySelectors: [".article-content", "[itemprop='articleBody']", "article"],
};
