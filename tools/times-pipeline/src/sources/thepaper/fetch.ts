import type { SourceFetchPolicy } from "../../types.js";

export const thepaperFetch = {
  capture: "browser",
  bodySelectors: [".index_cententWrap",".news_txt","article"],
} satisfies SourceFetchPolicy;
