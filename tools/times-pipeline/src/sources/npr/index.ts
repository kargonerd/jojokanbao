import type { SourceModule } from "../contracts.js";
import { nprFetch } from "./fetch.js";

export const nprSource: SourceModule = {
  id: "npr",
  fetch: nprFetch,
};
