import type { SourcePagePolicy } from "../../types.js";

export const cnaPage = {
  capture: "browser",
  bodySelectors: [
    ".text-long",
    ".article-content",
    ".content-detail__body",
    "[data-component='text-block']",
  ],
} satisfies SourcePagePolicy;
