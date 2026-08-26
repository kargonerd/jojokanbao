import type { SourceFetchPolicy } from "../../types.js";

export const agenciaBrasilFetch = {
  capture: "browser",
  bodySelectors: [".node__content",".field--name-body","article"],
} satisfies SourceFetchPolicy;
