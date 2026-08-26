import type { SourceModule } from "../contracts.js";
import { reutersFetch } from "./fetch.js";
import { processReuters } from "./process.js";

export const reutersSource: SourceModule = {
  id: "reuters",
  fetch: reutersFetch,
  process: processReuters,
};
