import type { SourceModule } from "../contracts.js";
import { nytFetch } from "./fetch.js";
import { extractNytImages } from "./images.js";
import { acceptNytUrl, processNytCandidate } from "./live.js";
import { extractNytBody } from "./process.js";

export const nytSource: SourceModule = {
  id: "nyt",
  fetch: nytFetch,
  acceptUrl: acceptNytUrl,
  process: processNytCandidate,
  extractBody: extractNytBody,
  extractImages: extractNytImages,
};
