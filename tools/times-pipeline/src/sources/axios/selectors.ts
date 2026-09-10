export const AXIOS_BODY_SELECTOR = "[data-cy='story-body'], .gtm-story-text, [data-testid='story-body']";
export const AXIOS_EXCLUDED_SELECTOR = [
  "aside", "nav", "footer", "[class*='author']", "[class*='byline']", "[class*='share']",
  "[class*='preferred']", "[class*='promo']", "[class*='recommend']", "[class*='related']", "[class*='advert']",
  "[data-testid*='author']", "[data-testid*='share']", "[data-testid*='recommend']",
  "[data-cy='author-image']", "[data-cy='byline-author']", "[data-vars-event-name='share_view']",
].join(",");
