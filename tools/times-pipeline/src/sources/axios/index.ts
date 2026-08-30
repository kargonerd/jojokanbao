import type { SourceModule } from "../contracts.js";
import { axiosFetch } from "./fetch.js";
import { extractAxiosImages } from "./images.js";
import { extractAxiosBody } from "./process.js";

export const axiosSource: SourceModule = {
  id: "axios",
  fetch: axiosFetch,
  extractBody: extractAxiosBody,
  extractImages: extractAxiosImages,
};
