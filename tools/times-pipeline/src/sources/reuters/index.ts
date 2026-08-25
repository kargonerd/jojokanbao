import type { SourceModule } from "../contracts.js";
import { reutersPage } from "./page.js";
import { processReuters } from "./process.js";

export const reutersSource: SourceModule = {
  id: "reuters",
  page: reutersPage,
  process: processReuters,
};
