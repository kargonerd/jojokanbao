import type { SourceModule } from "../contracts.js";
import { classifyScmpUnavailablePage } from "./availability.js";
import { scmpFetch } from "./fetch.js";
import { extractScmpImages } from "./images.js";
import { extractScmpBody } from "./process.js";

export const scmpSource: SourceModule = {
  id: "scmp",
  fetch: scmpFetch,
  extractBody: extractScmpBody,
  extractImages: extractScmpImages,
  classifyUnavailable: classifyScmpUnavailablePage,
};
