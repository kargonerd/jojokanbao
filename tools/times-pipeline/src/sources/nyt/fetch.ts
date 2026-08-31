import type { SourceFetchPolicy } from "../../types.js";

export const nytFetch = {
  capture: "browser",
  bodySelectors: ["section[name='articleBody']","#story","article"],
  revision: "official-graphql-v4",
} satisfies SourceFetchPolicy;
