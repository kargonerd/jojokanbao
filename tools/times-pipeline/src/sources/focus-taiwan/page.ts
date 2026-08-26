import type { SourcePagePolicy } from "../../types.js";

export const focusTaiwanPage: SourcePagePolicy = {
  capture: "browser",
  bodySelectors: [".paragraph", ".article-content", "[itemprop='articleBody']"],
};
