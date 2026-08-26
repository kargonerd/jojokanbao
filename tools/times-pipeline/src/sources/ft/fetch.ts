import type { SourceFetchPolicy } from "../../types.js";

export const ftFetch = {
  capture: "browser",
  bodySelectors: [".article__content-body","[data-content-id]","article"],
} satisfies SourceFetchPolicy;
