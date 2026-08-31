import type { SourceModule } from "../contracts.js";
import { ftFetch } from "./fetch.js";
import { extractFtImages } from "./images.js";
import { classifyFtAccessOffer, extractFtBody } from "./process.js";

export const ftSource: SourceModule = {
  id: "ft",
  fetch: ftFetch,
  extractBody: extractFtBody,
  classifyOriginalPageRejection: (html) => {
    const offer = classifyFtAccessOffer(html);
    return offer ? {
      kind: "access-offer",
      marker: offer.marker,
      location: "original-page",
      matchedSignals: offer.matchedSignals,
    } : undefined;
  },
  extractImages: extractFtImages,
  classifyStaleCanonicalBody: (previousBodyHtml) => (
    classifyFtAccessOffer(previousBodyHtml) ? "stale-publisher-access-offer" : undefined
  ),
};
