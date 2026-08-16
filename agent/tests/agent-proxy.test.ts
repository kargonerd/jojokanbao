import { afterEach, describe, expect, it, vi } from "vitest";
import {
  onRequest,
} from "../../infrastructure/edgeone/functions/agent-proxy/index";
import type { AgentProxyContext } from "../src/edgeone/proxy";
import {
  AGENT_SERVICE_AUTH_HEADERS,
  authorizeAgentServiceRequest,
} from "../src";

const allowedEnvironment = {
  JOJO_AGENT_ALLOWED_ORIGINS: "https://jojokanbao.cn",
  JOJO_AGENT_UPSTREAM_URL: "https://production-agent.example/jojo",
  JOJO_AGENT_SERVICE_SECRET: "0123456789abcdef0123456789abcdef",
  VITE_SUPABASE_URL: "https://example.supabase.co",
  VITE_SUPABASE_PUBLISHABLE_KEY: "publishable-key",
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

  it("forwards authenticated SSE requests to the same-project Agent", async () => {
    const fetchMock = vi.fn(
      async (input: string | URL | Request, _init?: RequestInit) => {
        if (String(input).includes("example.supabase.co")) {
          return Response.json([
            { flag_key: "agent.chat", enabled: true, revision: 4 },
          ]);
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
      "https://example.supabase.co/rest/v1/rpc/get_my_feature_flags",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          apikey: "publishable-key",
          authorization: "Bearer access-token",
        }),
        body: JSON.stringify({ p_keys: ["agent.chat"], p_visitor_id: null }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      new URL("https://preview-agent.example/jojo"),
      expect.objectContaining({ method: "POST" }),
    );
    const forwarded = fetchMock.mock.calls[1]?.[1];
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

  it("blocks disabled agent.chat requests before invoking the Agent", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) => Response.json([
      { flag_key: "agent.chat", enabled: false, revision: 5 },
    ]));
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("example.supabase.co");
  });

  it("requires a user login before evaluating agent.chat", async () => {
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

  it("preserves only the EdgeOne preview token for same-deployment health checks", async () => {
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
      new URL("https://preview-agent.example/jojo/health?eo_token=preview-secret"),
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("rejects untrusted browser origins before forwarding", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequest(context(new Request(
      "https://agent.example/agent",
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
      request: new Request("https://agent.example/agent", {
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
