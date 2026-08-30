import type { SourceModule } from "../contracts.js";
import { discoverChinanews } from "./discover.js";
import { chinanewsFetch } from "./fetch.js";
import { extractChinanewsImages } from "./images.js";
import { extractChinanewsBody } from "./process.js";

export const chinanewsSource: SourceModule = {
  id: "chinanews",
  discoverHttp: (source, endpoint, fetchedAt) => {
    if (endpoint.adapter !== "chinanews") throw new Error(`${source.id}: expected China News endpoint`);
    return discoverChinanews(source, endpoint, fetchedAt);
  },
  fetch: chinanewsFetch,
  extractBody: extractChinanewsBody,
  extractImages: extractChinanewsImages,
};
