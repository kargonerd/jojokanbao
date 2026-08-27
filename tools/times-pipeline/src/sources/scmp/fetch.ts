import type { SourceFetchPolicy } from "../../types.js";

export const scmpFetch = {
  capture: "browser",
  bodySelectors: [".article-body","[data-vr-contentbox]","article"],
} satisfies SourceFetchPolicy;
