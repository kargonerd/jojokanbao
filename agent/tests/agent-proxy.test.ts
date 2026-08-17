import { afterEach, describe, expect, it, vi } from "vitest";
import {
  onRequest,
} from "../../infrastructure/edgeone/functions/gateway/[[default]]";
import type {
  AgentProxyContext,
} from "../../infrastructure/edgeone/functions/_shared/agent-proxy";
import {
  AGENT_SERVICE_AUTH_HEADERS,
  authorizeAgentServiceRequest,
} from "../src";

const allowedEnvironment = {
  JOJO_AGENT_ALLOWED_ORIGINS: "https://jojokanbao.cn",
  JOJO_AGENT_UPSTREAM_URL: "https://production-agent.example/jojo",
  JOJO_AGENT_SERVICE_SECRET: "0123456789abcdef0123456789abcdef",
  JOJO_OPERATOR_TOKEN: "operator-token-0123456789abcdef0123456789abcdef",
  VITE_SUPABASE_URL: "https://example.supabase.co",
  VITE_SUPABASE_PUBLISHABLE_KEY: "publishable-key",
};

const enabledForUserConfig = {
  key: "rag.workspace",
  revision: 4,
  rules: [
    {
      id: "30000000-0000-4000-8000-000000000001",
      conditionType: "users",
      serve: true,
      enabled: true,
      startsAt: null,
      endsAt: null,
      userIds: ["user-1"],
    },
    {
      id: "30000000-0000-4000-8000-000000000002",
      conditionType: "global",
      serve: false,
      enabled: true,
      startsAt: null,
      endsAt: null,
      userIds: [],
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function context(request: Request): AgentProxyContext {
  return { env: allowedEnvironment, request };
}

describe("international Agent proxy", () => {
  it("answers browser preflight without invoking the Agent router", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequest(context(new Request(
      "https://preview-agent.example/gateway/ask",
      {
        method: "OPTIONS",
        headers: { origin: "https://jojokanbao.cn" },
      },
    )));

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin"))
      .toBe("https://jojokanbao.cn");
    expect(response.headers.get("access-control-allow-headers"))
      .toContain("Makers-Conversation-Id");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards authenticated SSE requests to the configured Agent origin", async () => {
    const fetchMock = vi.fn(
      async (input: string | URL | Request, _init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/auth/v1/user")) return Response.json({ id: "user-1" });
        if (url.endsWith("/rest/v1/rpc/operator_get_feature_flag")) {
          return Response.json(enabledForUserConfig);
        }
        return new Response("event: done\ndata: {}\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequest(context(new Request(
      "https://preview-agent.example/gateway/ask",
      {
        method: "POST",
        headers: {
          authorization: "Bearer access-token",
          "content-type": "application/json",
          "makers-conversation-id": "conversation-001",
          origin: "https://jojokanbao.cn",
        },
        body: JSON.stringify({ message: "你好" }),
      },
    )));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("event: done");
    expect(response.headers.get("access-control-allow-origin"))
      .toBe("https://jojokanbao.cn");
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://example.supabase.co/auth/v1/user",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          apikey: "publishable-key",
          authorization: "Bearer access-token",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://example.supabase.co/rest/v1/rpc/operator_get_feature_flag",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ apikey: "publishable-key" }),
        body: JSON.stringify({
          p_operator_token: allowedEnvironment.JOJO_OPERATOR_TOKEN,
          p_key: "rag.workspace",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      new URL("https://production-agent.example/jojo"),
      expect.objectContaining({ method: "POST" }),
    );
    const forwarded = fetchMock.mock.calls[2]?.[1];
    if (!forwarded) throw new Error("Expected forwarded request options");
    expect(new Headers(forwarded.headers).get("authorization"))
      .toBe("Bearer access-token");
    expect(new Headers(forwarded.headers).get("makers-conversation-id"))
      .toBe("conversation-001");
    for (const name of Object.values(AGENT_SERVICE_AUTH_HEADERS)) {
      expect(new Headers(forwarded.headers).get(name)).toBeTruthy();
    }
    await expect(authorizeAgentServiceRequest({
      env: allowedEnvironment,
      conversation_id: "conversation-001",
      request: {
        method: "POST",
        headers: new Headers(forwarded.headers),
        body: { message: "你好" },
      },
    })).resolves.toBeUndefined();
  });

  it("blocks disabled rag.workspace requests before invoking the Agent", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/auth/v1/user")) return Response.json({ id: "user-2" });
      if (url.endsWith("/rest/v1/rpc/operator_get_feature_flag")) {
        return Response.json(enabledForUserConfig);
      }
      throw new Error("The Agent must not be invoked");
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequest(context(new Request(
      "https://preview-agent.example/gateway/ask",
      {
        method: "POST",
        headers: {
          authorization: "Bearer access-token",
          "content-type": "application/json",
          "makers-conversation-id": "conversation-001",
          origin: "https://jojokanbao.cn",
        },
        body: JSON.stringify({ message: "你好" }),
      },
    )));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "This feature is not available",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed when Supabase rejects an expired login", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequest(context(new Request(
      "https://preview-agent.example/gateway/ask",
      {
        method: "POST",
        headers: {
          authorization: "Bearer expired-token",
          "content-type": "application/json",
          "makers-conversation-id": "conversation-001",
          origin: "https://jojokanbao.cn",
        },
        body: JSON.stringify({ message: "你好" }),
      },
    )));

    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses the same stable user percentage semantics as Postgres", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/auth/v1/user")) return Response.json({ id: "user-1" });
      if (url.endsWith("/rest/v1/rpc/operator_get_feature_flag")) {
        return Response.json({
          key: "rag.workspace",
          revision: 5,
          rules: [
            {
              id: "30000000-0000-4000-8000-000000000003",
              conditionType: "percentage",
              bucketBy: "user",
              bucketSalt: "30000000-0000-4000-8000-000000000004",
              // The Postgres-compatible hash puts user-1 in bucket 98.
              percentage: 99,
              serve: true,
              enabled: true,
              startsAt: null,
              endsAt: null,
              userIds: [],
            },
            enabledForUserConfig.rules[1],
          ],
        });
      }
      return new Response("event: done\ndata: {}\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequest(context(new Request(
      "https://preview-agent.example/gateway/ask",
      {
        method: "POST",
        headers: {
          authorization: "Bearer access-token",
          "content-type": "application/json",
          "makers-conversation-id": "conversation-001",
          origin: "https://jojokanbao.cn",
        },
        body: JSON.stringify({ message: "你好" }),
      },
    )));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("requires a user login before evaluating rag.workspace", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequest(context(new Request(
      "https://preview-agent.example/gateway/ask",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "makers-conversation-id": "conversation-001",
          origin: "https://jojokanbao.cn",
        },
        body: JSON.stringify({ message: "你好" }),
      },
    )));

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves only the EdgeOne preview token when checking the configured Agent", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequest(context(new Request(
      "https://preview-agent.example/gateway/ask?eo_token=preview-secret&ignored=value",
      { headers: { "makers-conversation-id": "health-check-001" } },
    )));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://production-agent.example/jojo/health?eo_token=preview-secret"),
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("rejects untrusted browser origins before forwarding", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequest(context(new Request(
      "https://agent.example/gateway/ask",
      {
        method: "POST",
        headers: {
          "makers-conversation-id": "conversation-001",
          origin: "https://attacker.example",
        },
        body: "{}",
      },
    )));

    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when the service secret is not configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequest({
      env: {
        JOJO_AGENT_ALLOWED_ORIGINS: "https://jojokanbao.cn",
        JOJO_AGENT_UPSTREAM_URL: "https://agent.example/jojo",
      },
      request: new Request("https://agent.example/gateway/ask", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "makers-conversation-id": "conversation-001",
          origin: "https://jojokanbao.cn",
        },
        body: JSON.stringify({ message: "你好" }),
      }),
    });

    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
