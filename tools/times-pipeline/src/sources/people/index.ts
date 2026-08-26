import type { SourceModule } from "../contracts.js";
import { discoverPeople } from "./discover.js";

export const peopleSource: SourceModule = {
  id: "people",
  discoverHttp: (source, endpoint, fetchedAt) => {
    if (endpoint.adapter !== "people") throw new Error(`${source.id}: expected People endpoint`);
    return discoverPeople(source, endpoint, fetchedAt);
  },
};
