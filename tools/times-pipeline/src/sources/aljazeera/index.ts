import type { SourceModule } from "../contracts.js";
import { alJazeeraFetch } from "./fetch.js";
import { discoverAlJazeera } from "./discover.js";

export const alJazeeraSource: SourceModule = {
  id: "aljazeera",
  fetch: alJazeeraFetch,
  discoverHttp: (source, endpoint, fetchedAt) => {
    if (endpoint.adapter !== "aljazeera") throw new Error(`${source.id}: expected Al Jazeera endpoint`);
    return discoverAlJazeera(source, endpoint, fetchedAt);
  },
};
