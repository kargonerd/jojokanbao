import type { SourceModule } from "../contracts.js";
import { agenciaBrasilFetch } from "./fetch.js";
import { discoverAgenciaBrasil } from "./discover.js";
import { extractAgenciaBrasilImages } from "./images.js";
import { extractAgenciaBrasilBody } from "./process.js";

export const agenciaBrasilSource: SourceModule = {
  id: "agencia-brasil",
  fetch: agenciaBrasilFetch,
  extractBody: extractAgenciaBrasilBody,
  extractImages: extractAgenciaBrasilImages,
  discoverHttp: (source, endpoint, fetchedAt) => {
    if (endpoint.adapter !== "agencia-brasil") throw new Error(`${source.id}: expected Agência Brasil endpoint`);
    return discoverAgenciaBrasil(source, endpoint, fetchedAt);
  },
};
