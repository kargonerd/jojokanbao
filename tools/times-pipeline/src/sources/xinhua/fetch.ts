import type { SourceFetchPolicy } from "../../types.js";

export const xinhuaFetch = {
  capture: "browser",
  bodySelectors: ["#detail",".main-aticle","article"],
  revision: "image-stories-v1",
} satisfies SourceFetchPolicy;
