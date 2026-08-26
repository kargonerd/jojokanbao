import type { SourcePagePolicy } from "../../types.js";

export const bloombergPage = {
  capture: "browser",
  bodySelectors: ["article", "main"],
  bodyExtractor: "bloomberg-next-data",
} satisfies SourcePagePolicy;
