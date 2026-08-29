import type { SourceFetchPolicy } from "../../types.js";

export const zaobaoFetch = {
  capture: "browser",
  bodySelectors: [".article-content",".article-body","article"],
} satisfies SourceFetchPolicy;
