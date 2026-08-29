import type { SourceFetchPolicy } from "../../types.js";

export const thepaperFetch = {
  capture: "browser",
  bodySelectors: ["[class*='cententWrap__']", ".index_cententWrap", ".news_txt", "article"],
  revision: "image-body-v2",
} satisfies SourceFetchPolicy;
