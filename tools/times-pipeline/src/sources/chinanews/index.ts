import type { SourceModule } from "../contracts.js";
import { discoverChinanews } from "./discover.js";
import { chinanewsPage } from "./page.js";

export const chinanewsSource: SourceModule = {
  id: "chinanews",
  discoverHttp: (source, endpoint, fetchedAt) => {
    if (endpoint.adapter !== "chinanews") throw new Error(`${source.id}: expected China News endpoint`);
    return discoverChinanews(source, endpoint, fetchedAt);
  },
  page: chinanewsPage,
};
