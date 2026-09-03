import type { SourceModule } from "../contracts.js";
import { reutersFetch } from "./fetch.js";
import { extractReutersImages } from "./images.js";
import { extractReutersBody, isReutersLiveBlogPage, processReuters } from "./process.js";

export const reutersSource: SourceModule = {
  id: "reuters",
  fetch: reutersFetch,
  classifyUnavailable: (input) => input.html && isReutersLiveBlogPage(input.html) ? "UnsupportedMedia" : undefined,
  extractBody: extractReutersBody,
  extractImages: extractReutersImages,
  process: processReuters,
};
