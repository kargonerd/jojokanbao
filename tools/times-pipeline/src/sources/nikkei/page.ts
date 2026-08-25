import type { SourcePagePolicy } from "../../types.js";

export const nikkeiPage: SourcePagePolicy = {
  capture: "browser",
  bodySelectors: [
    "div[class^='NewsArticle_newsArticleContentContainerWrapper']",
    "[itemprop='articleBody']",
  ],
};
