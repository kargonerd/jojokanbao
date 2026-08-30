import type { SourceFetchPolicy } from "../../types.js";

export const chinanewsFetch = {
  capture: "browser",
  bodySelectors: [".left_zw", ".content_desc"],
  revision: "semantic-media-v3",
} satisfies SourceFetchPolicy;
