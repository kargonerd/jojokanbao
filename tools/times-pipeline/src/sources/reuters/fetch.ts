import type { SourceFetchPolicy } from "../../types.js";

export const reutersFetch = {
  capture: "browser",
  captureUrl: "source",
  bodySelectors: [
    "[data-testid^='paragraph-'], [data-testid^='unordered-'] [data-testid='Body'], [data-testid='SignOff'] [data-testid='Body']",
  ],
} satisfies SourceFetchPolicy;
