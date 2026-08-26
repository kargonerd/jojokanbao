import type { SourceModule } from "../contracts.js";
import { bloombergFetch } from "./fetch.js";

export const bloombergSource: SourceModule = {
  id: "bloomberg",
  fetch: bloombergFetch,
};
