import type { SourceFetchPolicy } from "../../types.js";

export const chinanewsFetch = {
  capture: "browser",
  bodySelectors: ["#cont_1_1_2", ".content_maincontent_content", ".left_zw", ".content_desc"],
} satisfies SourceFetchPolicy;
