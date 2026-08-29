import type { SourceModule } from "../contracts.js";
import { reutersFetch } from "./fetch.js";
import { extractReutersImages } from "./images.js";
import { extractReutersBody, processReuters } from "./process.js";

export const reutersSource: SourceModule = {
  id: "reuters",
  fetch: reutersFetch,
  extractBody: extractReutersBody,
  extractImages: extractReutersImages,
  process: processReuters,
};
