import type { SourceModule } from "../contracts.js";
import { classifyNprUnavailablePage } from "./availability.js";
import { nprFetch } from "./fetch.js";

export const nprSource: SourceModule = {
  id: "npr",
  fetch: nprFetch,
  classifyUnavailable: classifyNprUnavailablePage,
};
