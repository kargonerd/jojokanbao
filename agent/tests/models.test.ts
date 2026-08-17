import { describe, expect, it } from "vitest";
import {
  DEFAULT_CODEX_REASONING,
  PersistentCredentialStore,
  createPlatformModelRuntime,
  resolvePlatformModelConfig,
} from "../src";

describe("resolvePlatformModelConfig", () => {
  it("uses the Codex default", () => {
    expect(resolvePlatformModelConfig({})).toEqual({
      provider: "openai-codex",
      model: "gpt-5.6-luna",
    });
    expect(DEFAULT_CODEX_REASONING).toBe("low");
  });

  it("accepts an explicit Codex model", () => {
    expect(resolvePlatformModelConfig({
      JOJO_AGENT_MODEL: "gpt-5.6-codex",
    })).toEqual({
      provider: "openai-codex",
      model: "gpt-5.6-codex",
    });
  });
});

describe("createPlatformModelRuntime", () => {
  it("recognizes a persisted Codex OAuth login without refreshing it", async () => {
    const credentials = new PersistentCredentialStore({
      read: async () => ({
        "openai-codex": {
          type: "oauth",
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        },
      }),
      write: async () => undefined,
    });
    const config = resolvePlatformModelConfig({});
    const runtime = await createPlatformModelRuntime({ config, credentials });

    expect(runtime.configured).toBe(true);
    expect(runtime.auth).toMatchObject({ type: "oauth", source: "OAuth" });
  });

  it("refreshes an expired Codex credential without loading Node-only OAuth code", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      access_token: "fresh-access",
      refresh_token: "fresh-refresh",
      expires_in: 3_600,
    }), { status: 200, headers: { "content-type": "application/json" } });
    let writtenAccess = "";
    const credentials = new PersistentCredentialStore({
      read: async () => ({
        "openai-codex": {
          type: "oauth",
          access: "expired-access",
          refresh: "expired-refresh",
          expires: 0,
        },
      }),
      write: async (next) => {
        const credential = next["openai-codex"];
        writtenAccess = credential?.type === "oauth" ? credential.access : "";
      },
    });

    try {
      const runtime = await createPlatformModelRuntime({
        config: resolvePlatformModelConfig({}),
        credentials,
      });
      const auth = await runtime.models.getAuth("openai-codex");
      expect(runtime.auth).toMatchObject({ type: "oauth", source: "OAuth" });
      expect(auth).toMatchObject({ auth: { apiKey: "fresh-access" }, source: "OAuth" });
      expect(writtenAccess).toBe("fresh-access");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
