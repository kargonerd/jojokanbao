import type { SourceFetchPolicy } from "../../types.js";

export const apFetch = {
  capture: "browser",
  bodySelectors: [".RichTextStoryBody", "[itemprop='articleBody']"],
} satisfies SourceFetchPolicy;
