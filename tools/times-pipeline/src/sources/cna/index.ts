import type { SourceModule } from "../contracts.js";
import { discoverCna } from "./discover.js";
import { cnaPage } from "./page.js";

export const cnaSource: SourceModule = {
  id: "cna",
  discoverHttp: (source, endpoint, fetchedAt) => {
    if (endpoint.adapter !== "cna") throw new Error(`${source.id}: expected CNA endpoint`);
    return discoverCna(source, endpoint, fetchedAt);
  },
  page: cnaPage,
};
