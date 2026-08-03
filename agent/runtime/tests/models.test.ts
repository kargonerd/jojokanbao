import { describe, expect, it } from "vitest";
import {
  PersistentCredentialStore,
  createPlatformModelRuntime,
  resolvePlatformModelConfig,
} from "../src";

describe("resolvePlatformModelConfig", () => {
  it("uses deployment-safe defaults for both regions", () => {
    expect(resolvePlatformModelConfig({}, "domestic")).toEqual({
      profile: "domestic",
      provider: "deepseek",
      model: "deepseek-v4-flash",
    });
    expect(resolvePlatformModelConfig({}, "international")).toEqual({
      profile: "international",
      provider: "openai-codex",
      model: "gpt-5.6-terra",
    });
  });

  it("accepts Gemini and provider aliases", () => {
    expect(resolvePlatformModelConfig({
      JOJO_AGENT_PROFILE: "domestic",
      JOJO_AGENT_PROVIDER: "gemini",
      JOJO_AGENT_MODEL: "gemini-3.5-flash",
    })).toEqual({
      profile: "domestic",
      provider: "google",
      model: "gemini-3.5-flash",
    });
  });
});

describe("createPlatformModelRuntime", () => {
  it("resolves DeepSeek API keys from the deployment environment", async () => {
    const config = resolvePlatformModelConfig({}, "domestic");
    const runtime = await createPlatformModelRuntime({
      config,
      environment: { DEEPSEEK_API_KEY: "test-key" },
    });

    expect(runtime.configured).toBe(true);
    expect(runtime.auth).toMatchObject({
      type: "api_key",
      source: "DEEPSEEK_API_KEY",
    });
  });

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
    const config = resolvePlatformModelConfig({}, "international");
    const runtime = await createPlatformModelRuntime({ config, credentials });

    expect(runtime.configured).toBe(true);
    expect(runtime.auth).toMatchObject({ type: "oauth", source: "OAuth" });
  });
});
