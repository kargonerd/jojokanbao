import type { SourceModule } from "../contracts.js";
import { axiosFetch } from "./fetch.js";

export const axiosSource: SourceModule = {
  id: "axios",
  fetch: axiosFetch,
};
