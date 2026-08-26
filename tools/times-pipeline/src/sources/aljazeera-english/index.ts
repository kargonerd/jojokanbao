import type { SourceModule } from "../contracts.js";
import { discoverAlJazeera } from "./discover.js";

export const alJazeeraSource: SourceModule = {
  id: "aljazeera-english",
  discoverHttp: (source, endpoint, fetchedAt) => {
    if (endpoint.adapter !== "aljazeera-english") throw new Error(`${source.id}: expected Al Jazeera endpoint`);
    return discoverAlJazeera(source, endpoint, fetchedAt);
  },
};
