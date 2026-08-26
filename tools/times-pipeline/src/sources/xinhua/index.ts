import type { SourceModule } from "../contracts.js";
import { xinhuaFetch } from "./fetch.js";
import { discoverXinhua } from "./discover.js";
import { processXinhua } from "./process.js";

export const xinhuaSource: SourceModule = {
  id: "xinhua",
  fetch: xinhuaFetch,
  discoverHttp: (source, endpoint, fetchedAt) => {
    if (endpoint.adapter !== "xinhua") throw new Error(`${source.id}: expected Xinhua endpoint`);
    return discoverXinhua(source, endpoint, fetchedAt);
  },
  process: processXinhua,
};
