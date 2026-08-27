import type { SourceModule } from "../contracts.js";
import { bloombergFetch } from "./fetch.js";
import { extractBloombergBody } from "./process.js";

export const bloombergSource: SourceModule = {
  id: "bloomberg",
  fetch: bloombergFetch,
  extractBody: extractBloombergBody,
};
