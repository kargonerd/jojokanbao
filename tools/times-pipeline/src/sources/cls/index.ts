import type { SourceModule } from "../contracts.js";
import { classifyClsUnavailablePage } from "./availability.js";
import { captureClsPage } from "./capture.js";
import { discoverCls } from "./discover.js";
import { clsFetch } from "./fetch.js";
import { extractClsImages } from "./images.js";
import { extractClsBody, processCls } from "./process.js";

export const clsSource: SourceModule = {
  id: "cls",
  discoverHttp: (source, endpoint, fetchedAt) => {
    if (endpoint.adapter !== "cls") throw new Error(`${source.id}: expected CLS endpoint`);
    return discoverCls(source, endpoint, fetchedAt);
  },
  capturePage: captureClsPage,
  fetch: clsFetch,
  extractBody: extractClsBody,
  extractImages: extractClsImages,
  classifyUnavailable: classifyClsUnavailablePage,
  process: processCls,
};
