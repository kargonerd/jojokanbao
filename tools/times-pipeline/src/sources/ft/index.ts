import type { SourceModule } from "../contracts.js";
import { ftFetch } from "./fetch.js";

export const ftSource: SourceModule = {
  id: "ft",
  fetch: ftFetch,
};
