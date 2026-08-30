import type { SourceModule } from "../contracts.js";
import { discoverPeople } from "./discover.js";
import { peopleFetch } from "./fetch.js";
import { extractPeopleImages } from "./images.js";
import { extractPeopleBody } from "./process.js";

export const peopleSource: SourceModule = {
  id: "people",
  discoverHttp: (source, endpoint, fetchedAt) => {
    if (endpoint.adapter !== "people") throw new Error(`${source.id}: expected People endpoint`);
    return discoverPeople(source, endpoint, fetchedAt);
  },
  fetch: peopleFetch,
  extractBody: extractPeopleBody,
  extractImages: extractPeopleImages,
};
