import { afterEach, describe, expect, it, vi } from "vitest";
import {
  onRequest,
  type AgentProxyContext,
} from "../../../infrastructure/edgeone/functions/agent-proxy/index";

const allowedEnvironment = {
  JOJO_AGENT_ALLOWED_ORIGINS: "https://jojokanbao.cn",
  JOJO_AGENT_UPSTREAM_URL: "https://agent.example/jojo",
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
      "https://agent.example/agent",
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
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response("event: done\ndata: {}\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequest(context(new Request(
      "https://agent.example/agent",
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
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://agent.example/jojo"),
      expect.objectContaining({ method: "POST" }),
    );
    const forwarded = fetchMock.mock.calls[0]?.[1];
    if (!forwarded) throw new Error("Expected forwarded request options");
    expect(new Headers(forwarded.headers).get("authorization"))
      .toBe("Bearer access-token");
    expect(new Headers(forwarded.headers).get("makers-conversation-id"))
      .toBe("conversation-001");
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
});
