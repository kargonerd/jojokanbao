import type { SourceModule } from "../contracts.js";
import { classifyNikkeiUnavailablePage } from "./availability.js";
import { discoverNikkei } from "./discover.js";
import { nikkeiFetch } from "./fetch.js";
import { extractNikkeiFreeArticleBody, processNikkei } from "./process.js";

export const nikkeiSource: SourceModule = {
  id: "nikkei",
  discoverHttp: (source, endpoint, fetchedAt) => {
    if (endpoint.adapter !== "nikkei") throw new Error(`${source.id}: expected Nikkei endpoint`);
    return discoverNikkei(source, endpoint, fetchedAt);
  },
  fetch: nikkeiFetch,
  extractBody: extractNikkeiFreeArticleBody,
  classifyUnavailable: classifyNikkeiUnavailablePage,
  process: processNikkei,
};
