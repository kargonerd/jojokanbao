import type { SourceModule } from "../contracts.js";
import { nytFetch } from "./fetch.js";
import { acceptNytUrl, processNytCandidate } from "./live.js";

export const nytSource: SourceModule = {
  id: "nyt",
  fetch: nytFetch,
  acceptUrl: acceptNytUrl,
  process: processNytCandidate,
};
