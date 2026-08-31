import type { SourceFetchPolicy } from "../../types.js";

export const guardianFetch = {
  capture: "browser",
  bodySelectors: ["[data-gu-name='body']",".article-body-commercial-selector","article"],
  revision: "guardian-body-assets-v2",
} satisfies SourceFetchPolicy;
