import type { SourceFetchPolicy } from "../../types.js";

export const thepaperFetch = {
  capture: "browser",
  bodySelectors: ["[class*='cententWrap__']", ".index_cententWrap", ".news_txt", "article"],
  revision: "semantic-media-v4",
} satisfies SourceFetchPolicy;
