import type { SourcePagePolicy } from "../../types.js";

export const bloombergPage: SourcePagePolicy = {
  capture: "browser",
  bodySelectors: ["article", "main"],
  bodyExtractor: "bloomberg-next-data",
};
