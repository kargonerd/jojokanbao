import type { SourceModule } from "../contracts.js";
import { discoverAfricanews } from "./discover.js";

export const africanewsSource: SourceModule = {
  id: "africanews",
  discoverHttp: (source, endpoint, fetchedAt) => {
    if (endpoint.adapter !== "africanews") throw new Error(`${source.id}: expected Africanews endpoint`);
    return discoverAfricanews(source, endpoint, fetchedAt);
  },
};
