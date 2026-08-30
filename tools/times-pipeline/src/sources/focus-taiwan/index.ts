import type { SourceModule } from "../contracts.js";
import { focusTaiwanFetch } from "./fetch.js";
import { extractFocusTaiwanImages } from "./images.js";
import { extractFocusTaiwanBody } from "./process.js";

export const focusTaiwanSource: SourceModule = {
  id: "focus-taiwan",
  fetch: focusTaiwanFetch,
  extractBody: extractFocusTaiwanBody,
  extractImages: extractFocusTaiwanImages,
  accept: (candidate) => candidate.title.trim().toLowerCase() !== "taiwan headline news",
};
