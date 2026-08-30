import type { SourceFetchPolicy } from "../../types.js";

export const peopleFetch = {
  capture: "browser",
  bodySelectors: ["#rm_txt_zw", "#rwb_zw", ".rm_txt_con"],
  revision: "semantic-media-v1",
} satisfies SourceFetchPolicy;
