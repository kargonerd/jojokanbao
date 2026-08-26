import type { SourcePagePolicy } from "../../types.js";

export const peoplePage: SourcePagePolicy = {
  capture: "browser",
  bodySelectors: ["#rwb_zw", ".rm_txt_con"],
};
