import type { SourceModule } from "../contracts.js";
import { thepaperFetch } from "./fetch.js";
import { discoverThepaper } from "./discover.js";
import { extractThepaperBody } from "./process.js";

export const thepaperSource: SourceModule = {
  id: "thepaper",
  fetch: thepaperFetch,
  extractBody: extractThepaperBody,
  discoverHttp: (source, endpoint, fetchedAt) => {
    if (endpoint.adapter !== "thepaper") throw new Error(`${source.id}: expected The Paper endpoint`);
    return discoverThepaper(source, endpoint, fetchedAt);
  },
};
