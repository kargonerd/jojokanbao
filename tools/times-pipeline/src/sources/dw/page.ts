import type { SourcePagePolicy } from "../../types.js";

export const dwPage: SourcePagePolicy = {
  capture: "browser",
  bodySelectors: ["main article", "[itemprop='articleBody']", "article"],
};
