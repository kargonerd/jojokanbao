import type { SourceModule } from "../contracts.js";
import { discoverCna } from "./discover.js";

export const cnaSource: SourceModule = {
  id: "cna-singapore",
  discoverHttp: (source, endpoint, fetchedAt) => {
    if (endpoint.adapter !== "cna-singapore") throw new Error(`${source.id}: expected CNA endpoint`);
    return discoverCna(source, endpoint, fetchedAt);
  },
};
