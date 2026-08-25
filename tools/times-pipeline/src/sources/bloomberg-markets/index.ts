import type { SourceModule } from "../contracts.js";
import { discoverBloomberg } from "./discover.js";

export const bloombergSource: SourceModule = {
  id: "bloomberg",
  discoverHttp: discoverBloomberg,
};
