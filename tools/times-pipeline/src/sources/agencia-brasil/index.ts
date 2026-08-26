import type { SourceModule } from "../contracts.js";
import { discoverAgenciaBrasil } from "./discover.js";

export const agenciaBrasilSource: SourceModule = {
  id: "agencia-brasil",
  discoverHttp: (source, endpoint, fetchedAt) => {
    if (endpoint.adapter !== "agencia-brasil") throw new Error(`${source.id}: expected Agência Brasil endpoint`);
    return discoverAgenciaBrasil(source, endpoint, fetchedAt);
  },
};
