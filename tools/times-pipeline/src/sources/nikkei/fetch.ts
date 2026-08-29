import type { SourceFetchPolicy } from "../../types.js";

export const nikkeiFetch = {
  capture: "browser",
  bodySelectors: [
    "div[class^='NewsArticle_newsArticleContentContainerWrapper']",
    "[class*='ArticleBodyWithTracking_articleBodyWithTracking']",
    "[class*='FeatureArticleBody_featureArticleBody']",
    "[id^='article-body']",
    "[itemprop='articleBody']",
  ],
  revision: "short-free-articles-v1",
} satisfies SourceFetchPolicy;
