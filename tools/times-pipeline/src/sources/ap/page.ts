import type { SourcePagePolicy } from "../../types.js";

export const apPage: SourcePagePolicy = {
  capture: "browser",
  bodySelectors: [".RichTextStoryBody", "[itemprop='articleBody']"],
};
