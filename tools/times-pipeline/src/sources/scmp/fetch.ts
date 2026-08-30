import type { SourceFetchPolicy } from "../../types.js";

export const scmpFetch = {
  capture: "browser",
  bodySelectors: [".article-body","[data-vr-contentbox]","article"],
  revision: "structured-content-v2",
} satisfies SourceFetchPolicy;
