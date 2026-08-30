import type { SourceModule } from "../contracts.js";
import { discoverAp } from "./discover.js";
import { apFetch } from "./fetch.js";
import { extractApImages } from "./images.js";
import { extractApBody, processAp } from "./process.js";

export const apSource: SourceModule = {
  id: "ap",
  discoverHttp: (source, endpoint, fetchedAt) => {
    if (endpoint.adapter !== "ap") throw new Error(`${source.id}: expected AP endpoint`);
    return discoverAp(source, endpoint, fetchedAt);
  },
  fetch: apFetch,
  extractBody: extractApBody,
  extractImages: extractApImages,
  process: processAp,
};
