import type { Model, Provider } from "@earendil-works/pi-ai";
import { getApiKey } from "pi-antigravity/src/auth/oauth.js";
import { DEFAULT_ENDPOINT } from "pi-antigravity/src/client/client.js";
import { refreshAntigravityModels } from "pi-antigravity/src/models/discovery.js";
import { getCurrentAntigravityCatalog, PROVIDER_ID, PROVIDER_NAME } from "pi-antigravity/src/models/models.js";
import { ANTIGRAVITY_API, streamAntigravity } from "pi-antigravity/src/stream/stream.js";
import { refreshAntigravityCredential } from "./auth";

export const DEFAULT_ANTIGRAVITY_MODEL = "gemini-3.5-flash-lite";

/** Keep the pinned extension's internal imports at this adapter boundary. */
export function antigravityProvider(): Provider<typeof ANTIGRAVITY_API> {
  return {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    baseUrl: DEFAULT_ENDPOINT,
    auth: {
      oauth: {
        name: "Antigravity (Google OAuth)",
        login: async () => {
          throw new Error("Run pnpm --filter @jojo/agent auth:antigravity to sign in locally");
        },
        refresh: refreshAntigravityCredential,
        toAuth: async (credential) => ({ apiKey: getApiKey(credential) }),
      },
    },
    getModels: (): Model<typeof ANTIGRAVITY_API>[] => getCurrentAntigravityCatalog().models.map((model) => ({
      ...model,
      compat: undefined,
      api: ANTIGRAVITY_API,
      provider: PROVIDER_ID,
      baseUrl: DEFAULT_ENDPOINT,
    })),
    refreshModels: async (context) => { await refreshAntigravityModels(context); },
    stream: streamAntigravity,
    streamSimple: streamAntigravity,
  };
}
