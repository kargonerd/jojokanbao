import type { SourceModule } from "../contracts.js";
import { discoverDw } from "./discover.js";
import { dwFetch } from "./fetch.js";
import { extractDwBody } from "./body.js";
import { extractDwImages } from "./images.js";
import { processDw } from "./process.js";

function acceptDwUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!["dw.com", "www.dw.com"].includes(url.hostname.toLowerCase())) return true;
    const lastSegment = url.pathname.toLowerCase().split("/").filter(Boolean).at(-1) ?? "";
    return !/^live-\d+$/u.test(lastSegment);
  } catch {
    return true;
  }
}

export const dwSource: SourceModule = {
  id: "dw",
  discoverHttp: (source, endpoint, fetchedAt) => {
    if (endpoint.adapter !== "dw") throw new Error(`${source.id}: expected DW endpoint`);
    return discoverDw(source, endpoint, fetchedAt);
  },
  fetch: dwFetch,
  acceptUrl: acceptDwUrl,
  extractBody: extractDwBody,
  extractImages: extractDwImages,
  process: processDw,
};
