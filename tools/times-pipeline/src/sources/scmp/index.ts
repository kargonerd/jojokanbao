import type { SourceModule } from "../contracts.js";
import { scmpFetch } from "./fetch.js";

export const scmpSource: SourceModule = {
  id: "scmp",
  fetch: scmpFetch,
};
