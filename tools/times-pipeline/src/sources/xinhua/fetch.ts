import type { SourceFetchPolicy } from "../../types.js";

export const xinhuaFetch = {
  capture: "browser",
  bodySelectors: ["#detail",".main-aticle","article"],
  revision: "semantic-media-v2",
} satisfies SourceFetchPolicy;
