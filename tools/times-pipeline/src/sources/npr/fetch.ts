import type { SourceFetchPolicy } from "../../types.js";

export const nprFetch = {
  capture: "browser",
  bodySelectors: ["#storytext",".storytext","[data-testid='story-text']","article"],
  revision: "exclude-audio-transcripts-v3",
} satisfies SourceFetchPolicy;
