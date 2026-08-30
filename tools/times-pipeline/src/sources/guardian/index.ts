import type { SourceModule } from "../contracts.js";
import { guardianFetch } from "./fetch.js";
import { extractGuardianImages } from "./images.js";
import { extractGuardianBody } from "./process.js";

function acceptGuardianUrl(value: string): boolean {
  try {
    return !new URL(value).pathname.toLowerCase().split("/").includes("audio");
  } catch {
    return true;
  }
}

export const guardianSource: SourceModule = {
  id: "guardian",
  fetch: guardianFetch,
  acceptUrl: acceptGuardianUrl,
  extractBody: extractGuardianBody,
  extractImages: extractGuardianImages,
};
