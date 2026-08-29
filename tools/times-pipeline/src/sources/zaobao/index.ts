import type { SourceModule } from "../contracts.js";
import { zaobaoFetch } from "./fetch.js";
import { discoverZaobao } from "./discover.js";
import { extractZaobaoImages } from "./images.js";
import { extractZaobaoBody } from "./process.js";

export const zaobaoSource: SourceModule = {
  id: "zaobao",
  fetch: zaobaoFetch,
  extractBody: extractZaobaoBody,
  extractImages: extractZaobaoImages,
  discoverHttp: (source, endpoint, fetchedAt) => {
    if (endpoint.adapter !== "zaobao") throw new Error(`${source.id}: expected Zaobao endpoint`);
    return discoverZaobao(source, endpoint, fetchedAt);
  },
};
