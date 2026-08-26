import type { SourcePagePolicy } from "../../types.js";

export const chinanewsPage: SourcePagePolicy = {
  capture: "browser",
  bodySelectors: ["#cont_1_1_2", ".content_maincontent_content", ".left_zw", ".content_desc"],
};
