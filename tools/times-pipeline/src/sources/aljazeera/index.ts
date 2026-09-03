import type { SourceModule } from "../contracts.js";
import { captureAlJazeeraPage } from "./capture.js";
import { alJazeeraFetch } from "./fetch.js";
import { discoverAlJazeera } from "./discover.js";
import { extractAlJazeeraImages } from "./images.js";
import { extractAlJazeeraBody } from "./process.js";

function acceptAlJazeeraUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!["aljazeera.com", "www.aljazeera.com"].includes(url.hostname.toLowerCase())) return true;
    const segments = url.pathname.toLowerCase().split("/").filter(Boolean);
    return !segments.includes("liveblog") && !segments.includes("live");
  } catch {
    return true;
  }
}

export const alJazeeraSource: SourceModule = {
  id: "aljazeera",
  capturePage: captureAlJazeeraPage,
  fetch: alJazeeraFetch,
  acceptUrl: acceptAlJazeeraUrl,
  extractBody: extractAlJazeeraBody,
  extractImages: extractAlJazeeraImages,
  discoverHttp: (source, endpoint, fetchedAt) => {
    if (endpoint.adapter !== "aljazeera") throw new Error(`${source.id}: expected Al Jazeera endpoint`);
    return discoverAlJazeera(source, endpoint, fetchedAt);
  },
};
