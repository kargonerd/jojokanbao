import type { SourceFetchPolicy } from "../../types.js";

export const xinhuaFetch = {
  capture: "browser",
  bodySelectors: ["#detail",".main-aticle","article"],
} satisfies SourceFetchPolicy;
