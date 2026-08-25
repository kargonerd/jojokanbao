import type { SourcePagePolicy } from "../../types.js";

export const reutersPage: SourcePagePolicy = {
  capture: "browser",
  bodySelectors: ["[data-testid^='paragraph-']"],
};
