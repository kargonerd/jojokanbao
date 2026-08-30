import type { SourceModule } from "../contracts.js";
import { classifyXinhuaUnavailablePage } from "./availability.js";
import { discoverXinhua } from "./discover.js";
import { xinhuaFetch } from "./fetch.js";
import { extractXinhuaImages } from "./images.js";
import { extractXinhuaBody } from "./process.js";

export const xinhuaSource: SourceModule = {
  id: "xinhua",
  fetch: xinhuaFetch,
  extractBody: extractXinhuaBody,
  extractImages: extractXinhuaImages,
  classifyUnavailable: classifyXinhuaUnavailablePage,
  discoverHttp: (source, endpoint, fetchedAt) => {
    if (endpoint.adapter !== "xinhua") throw new Error(`${source.id}: expected Xinhua endpoint`);
    return discoverXinhua(source, endpoint, fetchedAt);
  },
};
