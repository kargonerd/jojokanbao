import { describe, expect, it } from "vitest";
import {
  DEFAULT_CODEX_REASONING,
  PersistentCredentialStore,
  createPlatformModelRuntime,
  modelRuntimeStream,
  resolvePlatformModelConfig,
  runPlatformAgent,
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

  it("switches providers with independent defaults and rejects unknown providers", () => {
    expect(resolvePlatformModelConfig({ JOJO_AGENT_PROVIDER: " antigravity " })).toEqual({
      provider: "antigravity", model: "gemini-3.5-flash-lite",
    });
    expect(resolvePlatformModelConfig({ JOJO_AGENT_PROVIDER: "antigravity", JOJO_AGENT_MODEL: "claude-sonnet-4-6" }).model)
      .toBe("claude-sonnet-4-6");
    expect(() => resolvePlatformModelConfig({ JOJO_AGENT_PROVIDER: "typo" })).toThrow("Unsupported JOJO_AGENT_PROVIDER");
  });

  it("rejects a model belonging to the other provider", async () => {
    await expect(createPlatformModelRuntime({
      config: resolvePlatformModelConfig({ JOJO_AGENT_PROVIDER: "antigravity", JOJO_AGENT_MODEL: "gpt-5.6-luna" }),
      environment: {},
    })).rejects.toThrow("Pi model catalog does not contain");
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
          generation: 7,
          accountId: "account-metadata",
        },
      }),
      write: async (next) => {
        const credential = next["openai-codex"];
        writtenAccess = credential?.type === "oauth" ? credential.access : "";
        expect(credential).toMatchObject({
          generation: 7,
          accountId: "account-metadata",
        });
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

  it("classifies a reused refresh token without exposing the provider response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      error: {
        code: "refresh_token_reused",
        message: "provider-detail-must-not-be-exposed",
      },
    }), { status: 401, headers: { "content-type": "application/json" } });
    const credentials = new PersistentCredentialStore({
      read: async () => ({
        "openai-codex": {
          type: "oauth",
          access: "expired-access",
          refresh: "spent-refresh",
          expires: 0,
        },
      }),
      write: async () => undefined,
    });

    try {
      const runtime = await createPlatformModelRuntime({
        config: resolvePlatformModelConfig({}),
        credentials,
      });
      let failure: unknown;
      try {
        await runtime.models.getAuth("openai-codex");
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("重新登录");
      expect((failure as Error).message).not.toContain(
        "provider-detail-must-not-be-exposed",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

const COMPATIBLE_ENV = {
  JOJO_AGENT_PROVIDER: "openai-compatible",
  JOJO_AGENT_MODEL: "gpt-5.6-luna",
  JOJO_AGENT_BASE_URL: "https://api.0-0.pro/v1",
  JOJO_AGENT_API_KEY: "test-key",
};

function openAICompatibleStreamResponse(): Response {
  const chunk = (payload: Record<string, unknown>): string => `data: ${JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-5.6-luna",
    ...payload,
  })}`;
  return new Response([
    chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "你好" }, finish_reason: null }] }),
    chunk({ choices: [{ index: 0, delta: { content: "，世界" }, finish_reason: null }] }),
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    chunk({
      choices: [],
      usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
    }),
    "data: [DONE]",
    "",
  ].join("\n\n"), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("openai-compatible provider", () => {
  it("resolves the endpoint configuration", () => {
    expect(resolvePlatformModelConfig(COMPATIBLE_ENV)).toEqual({
      provider: "openai-compatible",
      model: "gpt-5.6-luna",
      baseUrl: "https://api.0-0.pro/v1",
    });
  });

  it("requires the model and an absolute http(s) base url", () => {
    expect(() => resolvePlatformModelConfig({
      JOJO_AGENT_PROVIDER: "openai-compatible",
      JOJO_AGENT_BASE_URL: "https://api.0-0.pro/v1",
    })).toThrow("JOJO_AGENT_MODEL is required");
    expect(() => resolvePlatformModelConfig({
      JOJO_AGENT_PROVIDER: "openai-compatible",
      JOJO_AGENT_MODEL: "gpt-5.6-luna",
    })).toThrow("JOJO_AGENT_BASE_URL is required");
    expect(() => resolvePlatformModelConfig({
      ...COMPATIBLE_ENV,
      JOJO_AGENT_BASE_URL: "api.0-0.pro/v1",
    })).toThrow("must be an absolute http(s) URL");
    expect(() => resolvePlatformModelConfig({
      ...COMPATIBLE_ENV,
      JOJO_AGENT_BASE_URL: "ftp://api.0-0.pro/v1",
    })).toThrow("must be an absolute http(s) URL");
  });

  it("registers the configured model and reads JOJO_AGENT_API_KEY", async () => {
    const runtime = await createPlatformModelRuntime({
      config: resolvePlatformModelConfig(COMPATIBLE_ENV),
      environment: COMPATIBLE_ENV,
    });

    expect(runtime.configured).toBe(true);
    expect(runtime.auth).toMatchObject({ type: "api_key" });
    expect(runtime.model).toMatchObject({
      id: "gpt-5.6-luna",
      api: "openai-completions",
      provider: "openai-compatible",
      baseUrl: "https://api.0-0.pro/v1",
    });
    expect(runtime.models.getModel("openai-compatible", "gpt-5.6-luna"))
      .toBe(runtime.model);
  });

  it("stays unconfigured without the dedicated API key variable", async () => {
    const environment = {
      ...COMPATIBLE_ENV,
      JOJO_AGENT_API_KEY: undefined,
      OPENAI_API_KEY: "unrelated-provider-key",
    };
    const runtime = await createPlatformModelRuntime({
      config: resolvePlatformModelConfig(environment),
      environment,
    });

    expect(runtime.configured).toBe(false);
    expect(runtime.auth).toBeUndefined();
  });

  it("prefers a stored api_key credential over the environment variable", async () => {
    const credentials = new PersistentCredentialStore({
      read: async () => ({
        "openai-compatible": { type: "api_key", key: "stored-key" },
      }),
      write: async () => undefined,
    });
    const runtime = await createPlatformModelRuntime({
      config: resolvePlatformModelConfig(COMPATIBLE_ENV),
      environment: COMPATIBLE_ENV,
      credentials,
    });

    await expect(runtime.models.getAuth("openai-compatible")).resolves.toMatchObject({
      auth: { apiKey: "stored-key" },
    });
  });

  it("streams through the configured endpoint", async () => {
    const originalFetch = globalThis.fetch;
    const requests: {
      url: string;
      authorization: string | null;
      body: Record<string, unknown>;
    }[] = [];
    globalThis.fetch = async (input, init) => {
      requests.push({
        url: input instanceof Request ? input.url : String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return openAICompatibleStreamResponse();
    };

    try {
      const runtime = await createPlatformModelRuntime({
        config: resolvePlatformModelConfig(COMPATIBLE_ENV),
        environment: COMPATIBLE_ENV,
      });
      const deltas: string[] = [];
      const result = await runPlatformAgent({
        systemPrompt: "你是测试助手。",
        prompt: "打个招呼",
        model: runtime.model,
        stream: modelRuntimeStream(runtime),
        onEvent(event) {
          if (event.type === "text_delta") deltas.push(event.delta);
        },
      });

      expect(result.answer).toBe("你好，世界");
      expect(deltas.join("")).toBe("你好，世界");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("https://api.0-0.pro/v1/chat/completions");
      expect(requests[0]?.authorization).toBe("Bearer test-key");
      expect(requests[0]?.body).toMatchObject({
        model: "gpt-5.6-luna",
        stream: true,
      });
      expect(result.usage.totalTokens).toBe(18);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
