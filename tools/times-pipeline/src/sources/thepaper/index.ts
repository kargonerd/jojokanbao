import type { SourceModule } from "../contracts.js";
import { discoverThepaper } from "./discover.js";

export const thepaperSource: SourceModule = {
  id: "thepaper",
  discoverHttp: (source, endpoint, fetchedAt) => {
    if (endpoint.adapter !== "thepaper") throw new Error(`${source.id}: expected The Paper endpoint`);
    return discoverThepaper(source, endpoint, fetchedAt);
  },
};
