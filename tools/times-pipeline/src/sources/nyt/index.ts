import type { SourceModule } from "../contracts.js";
import { nytFetch } from "./fetch.js";

export const nytSource: SourceModule = {
  id: "nyt",
  fetch: nytFetch,
};
