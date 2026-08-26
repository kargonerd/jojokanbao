import type { SourceModule } from "../contracts.js";
import { focusTaiwanPage } from "./page.js";

export const focusTaiwanSource: SourceModule = {
  id: "focus-taiwan",
  page: focusTaiwanPage,
  accept: (candidate) => candidate.title.trim().toLowerCase() !== "taiwan headline news",
};
