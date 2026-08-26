import type { SourceModule } from "../contracts.js";
import { focusTaiwanFetch } from "./fetch.js";

export const focusTaiwanSource: SourceModule = {
  id: "focus-taiwan",
  fetch: focusTaiwanFetch,
  accept: (candidate) => candidate.title.trim().toLowerCase() !== "taiwan headline news",
};
