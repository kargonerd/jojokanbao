import type { SourceModule } from "../contracts.js";
import { guardianFetch } from "./fetch.js";
import { extractGuardianImages } from "./images.js";
import { extractGuardianBody } from "./process.js";

function acceptGuardianUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!["theguardian.com", "www.theguardian.com"].includes(url.hostname.toLowerCase())) return true;
    const segments = url.pathname.toLowerCase().split("/").filter(Boolean);
    return !segments.includes("audio") && !segments.includes("live");
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
