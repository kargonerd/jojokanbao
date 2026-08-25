import type { SourceModule } from "../contracts.js";
import { bloombergPage } from "./page.js";

export const bloombergSource: SourceModule = {
  id: "bloomberg-markets",
  page: bloombergPage,
};
