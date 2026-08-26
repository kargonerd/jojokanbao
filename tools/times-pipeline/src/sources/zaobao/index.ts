import type { SourceModule } from "../contracts.js";
import { discoverZaobao } from "./discover.js";

export const zaobaoSource: SourceModule = {
  id: "zaobao",
  discoverHttp: (source, endpoint, fetchedAt) => {
    if (endpoint.adapter !== "zaobao") throw new Error(`${source.id}: expected Zaobao endpoint`);
    return discoverZaobao(source, endpoint, fetchedAt);
  },
};
