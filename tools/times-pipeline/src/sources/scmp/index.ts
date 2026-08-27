import type { SourceModule } from "../contracts.js";
import { classifyScmpUnavailablePage } from "./availability.js";
import { scmpFetch } from "./fetch.js";

export const scmpSource: SourceModule = {
  id: "scmp",
  fetch: scmpFetch,
  classifyUnavailable: classifyScmpUnavailablePage,
};
