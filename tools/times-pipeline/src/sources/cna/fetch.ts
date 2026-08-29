import type { SourceFetchPolicy } from "../../types.js";

export const cnaFetch = {
  capture: "browser",
  bodySelectors: [
    "article.node--article-content section.block-field-blocknodearticlefield-content .text-long",
    ".content-detail__body",
    "[data-component='text-block']",
  ],
  revision: "semantic-media-v2",
} satisfies SourceFetchPolicy;
