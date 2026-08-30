import type { SourceModule } from "../contracts.js";
import { classifyNprUnavailablePage } from "./availability.js";
import { nprFetch } from "./fetch.js";
import { extractNprImages } from "./images.js";
import { extractNprBody } from "./process.js";

export const nprSource: SourceModule = {
  id: "npr",
  fetch: nprFetch,
  extractBody: extractNprBody,
  extractImages: extractNprImages,
  classifyUnavailable: classifyNprUnavailablePage,
};
