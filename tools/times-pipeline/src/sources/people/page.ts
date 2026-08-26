import type { SourcePagePolicy } from "../../types.js";

export const peoplePage: SourcePagePolicy = {
  capture: "browser",
  bodySelectors: ["#rm_txt_zw", "#rwb_zw", ".rm_txt_con"],
};
