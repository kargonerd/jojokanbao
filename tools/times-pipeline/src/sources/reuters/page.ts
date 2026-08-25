import type { SourcePagePolicy } from "../../types.js";

export const reutersPage: SourcePagePolicy = {
  capture: "browser",
  captureUrl: "source",
  bodySelectors: [
    "[data-testid^='paragraph-'], [data-testid^='unordered-'] [data-testid='Body'], [data-testid='SignOff'] [data-testid='Body']",
  ],
};
