import type { SourceFetchPolicy } from "../../types.js";

export const cnaFetch = {
  capture: "browser",
  bodySelectors: [".text-long", ".article-content", ".content-detail__body", "[data-component='text-block']"],
} satisfies SourceFetchPolicy;
