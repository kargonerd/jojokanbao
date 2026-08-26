import type { SourceModule } from "../contracts.js";
import { discoverCls } from "./discover.js";
import { clsFetch } from "./fetch.js";
import { processCls } from "./process.js";

export const clsSource: SourceModule = {
  id: "cls",
  discoverHttp: (source, endpoint, fetchedAt) => {
    if (endpoint.adapter !== "cls") throw new Error(`${source.id}: expected CLS endpoint`);
    return discoverCls(source, endpoint, fetchedAt);
  },
  fetch: clsFetch,
  process: processCls,
};
