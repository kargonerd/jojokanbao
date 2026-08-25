import type { SourceModule } from "../contracts.js";
import { discoverAp } from "./discover.js";
import { apPage } from "./page.js";
import { processAp } from "./process.js";

export const apSource: SourceModule = {
  id: "ap",
  discoverHttp: (source, endpoint, fetchedAt) => {
    if (endpoint.adapter !== "ap") throw new Error(`${source.id}: expected AP endpoint`);
    return discoverAp(source, endpoint, fetchedAt);
  },
  page: apPage,
  process: processAp,
};
