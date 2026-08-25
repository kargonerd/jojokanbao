import type { SourceModule } from "../contracts.js";
import { discoverDw } from "./discover.js";
import { dwPage } from "./page.js";
import { processDw } from "./process.js";

export const dwSource: SourceModule = {
  id: "dw",
  discoverHttp: (source, endpoint, fetchedAt) => {
    if (endpoint.adapter !== "dw") throw new Error(`${source.id}: expected DW endpoint`);
    return discoverDw(source, endpoint, fetchedAt);
  },
  page: dwPage,
  process: processDw,
};
