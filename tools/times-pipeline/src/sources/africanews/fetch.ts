import type { SourceFetchPolicy } from "../../types.js";

export const africanewsFetch = {
  capture: "browser",
  bodySelectors: [".article-content",".article__body","article"],
  revision: "semantic-media-v1",
} satisfies SourceFetchPolicy;
