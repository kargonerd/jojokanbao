import type { SourceModule } from "../contracts.js";
import { discoverNikkei } from "./discover.js";
import { nikkeiPage } from "./page.js";
import { processNikkei } from "./process.js";

export const nikkeiSource: SourceModule = {
  id: "nikkei",
  discoverHttp: (source, endpoint, fetchedAt) => {
    if (endpoint.adapter !== "nikkei") throw new Error(`${source.id}: expected Nikkei endpoint`);
    return discoverNikkei(source, endpoint, fetchedAt);
  },
  page: nikkeiPage,
  process: processNikkei,
};
