import type { SourceModule } from "../contracts.js";
import { ftFetch } from "./fetch.js";
import { extractFtImages } from "./images.js";
import { extractFtBody } from "./process.js";

export const ftSource: SourceModule = {
  id: "ft",
  fetch: ftFetch,
  extractBody: extractFtBody,
  extractImages: extractFtImages,
};
