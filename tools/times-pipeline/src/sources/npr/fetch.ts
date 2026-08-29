import type { SourceFetchPolicy } from "../../types.js";

export const nprFetch = {
  capture: "browser",
  bodySelectors: ["#storytext",".storytext","[data-testid='story-text']","article"],
  // NPR can add transcripts after initially publishing an audio-only page.
  unsupportedMediaRefreshHours: 2,
} satisfies SourceFetchPolicy;
