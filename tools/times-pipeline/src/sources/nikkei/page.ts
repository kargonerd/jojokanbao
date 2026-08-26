import type { SourcePagePolicy } from "../../types.js";

export const nikkeiPage: SourcePagePolicy = {
  capture: "browser",
  bodySelectors: [
    "div[class^='NewsArticle_newsArticleContentContainerWrapper']",
    "[class*='ArticleBodyWithTracking_articleBodyWithTracking']",
    "[class*='FeatureArticleBody_featureArticleBody']",
    "[id^='article-body']",
    "[itemprop='articleBody']",
  ],
};
