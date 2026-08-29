import type { SourceFetchPolicy } from "../../types.js";

export const nprFetch = {
  capture: "browser",
  bodySelectors: ["#storytext",".storytext","[data-testid='story-text']","article"],
} satisfies SourceFetchPolicy;
