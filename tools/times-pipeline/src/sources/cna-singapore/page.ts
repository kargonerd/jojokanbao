import type { SourcePagePolicy } from "../../types.js";

export const cnaPage: SourcePagePolicy = {
  capture: "browser",
  bodySelectors: [
    ".text-long",
    ".article-content",
    ".content-detail__body",
    "[data-component='text-block']",
  ],
};
