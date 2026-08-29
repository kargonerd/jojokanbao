import type { SourceModule } from "../contracts.js";
import { guardianFetch } from "./fetch.js";

export const guardianSource: SourceModule = {
  id: "guardian",
  fetch: guardianFetch,
};
