import type { SourceModule } from "../contracts.js";
import { africanewsFetch } from "./fetch.js";
import { discoverAfricanews } from "./discover.js";

export const africanewsSource: SourceModule = {
  id: "africanews",
  fetch: africanewsFetch,
  discoverHttp: (source, endpoint, fetchedAt) => {
    if (endpoint.adapter !== "africanews") throw new Error(`${source.id}: expected Africanews endpoint`);
    return discoverAfricanews(source, endpoint, fetchedAt);
  },
};
