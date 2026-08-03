import { describe, expect, it } from "vitest";
import {
  PersistentCredentialStore,
  createPlatformModelRuntime,
  resolvePlatformModelConfig,
} from "../src";

describe("resolvePlatformModelConfig", () => {
  it("uses the Codex default", () => {
    expect(resolvePlatformModelConfig({})).toEqual({
      provider: "openai-codex",
      model: "gpt-5.6-terra",
    });
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
          expires: 0,
        },
      }),
      write: async () => undefined,
    });
    const config = resolvePlatformModelConfig({});
    const runtime = await createPlatformModelRuntime({ config, credentials });

    expect(runtime.configured).toBe(true);
    expect(runtime.auth).toMatchObject({ type: "oauth", source: "OAuth" });
  });
});
