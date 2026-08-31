import type { SourceFetchPolicy } from "../../types.js";

export const alJazeeraFetch = {
  capture: "browser",
  bodySelectors: [".wysiwyg",".article-p-wrapper","article"],
  revision: "publisher-content-v3",
} satisfies SourceFetchPolicy;
