import type { SourceModule } from "../contracts.js";
import { ftFetch } from "./fetch.js";
import { extractFtImages } from "./images.js";
import { classifyFtAccessOffer, extractFtBody } from "./process.js";

export const ftSource: SourceModule = {
  id: "ft",
  fetch: ftFetch,
  extractBody: extractFtBody,
  extractImages: extractFtImages,
  classifyStaleCanonicalBody: (previousBodyHtml) => (
    classifyFtAccessOffer(previousBodyHtml) ? "stale-publisher-access-offer" : undefined
  ),
};
