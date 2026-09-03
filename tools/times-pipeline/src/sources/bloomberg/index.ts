import type { SourceModule } from "../contracts.js";
import { bloombergFetch } from "./fetch.js";
import { extractBloombergImages } from "./images.js";
import { extractBloombergBody } from "./process.js";

function acceptBloombergUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!["bloomberg.com", "www.bloomberg.com"].includes(url.hostname.toLowerCase())) return true;
    const segments = url.pathname.toLowerCase().split("/").filter(Boolean);
    return segments[0] !== "news" || !["audio", "live-blog"].includes(segments[1] ?? "");
  } catch {
    return true;
  }
}

export const bloombergSource: SourceModule = {
  id: "bloomberg",
  fetch: bloombergFetch,
  acceptUrl: acceptBloombergUrl,
  extractBody: extractBloombergBody,
  extractImages: extractBloombergImages,
};
