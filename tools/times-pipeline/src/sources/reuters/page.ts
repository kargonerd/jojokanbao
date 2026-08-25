import type { SourcePagePolicy } from "../../types.js";

export const reutersPage: SourcePagePolicy = {
  capture: "browser",
  captureUrl: "source",
  bodySelectors: ["[data-testid^='paragraph-']"],
};
