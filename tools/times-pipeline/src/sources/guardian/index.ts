import type { SourceModule } from "../contracts.js";
import { guardianFetch } from "./fetch.js";
import { extractGuardianImages } from "./images.js";
import { extractGuardianBody } from "./process.js";

export const guardianSource: SourceModule = {
  id: "guardian",
  fetch: guardianFetch,
  extractBody: extractGuardianBody,
  extractImages: extractGuardianImages,
};
