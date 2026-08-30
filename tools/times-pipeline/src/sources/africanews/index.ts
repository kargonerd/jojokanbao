import type { SourceModule } from "../contracts.js";
import { africanewsFetch } from "./fetch.js";
import { discoverAfricanews } from "./discover.js";
import { extractAfricanewsImages } from "./images.js";
import { extractAfricanewsBody } from "./process.js";

export const africanewsSource: SourceModule = {
  id: "africanews",
  fetch: africanewsFetch,
  extractBody: extractAfricanewsBody,
  extractImages: extractAfricanewsImages,
  discoverHttp: (source, endpoint, fetchedAt) => {
    if (endpoint.adapter !== "africanews") throw new Error(`${source.id}: expected Africanews endpoint`);
    return discoverAfricanews(source, endpoint, fetchedAt);
  },
};
