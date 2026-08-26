import { afterEach, describe, expect, it, vi } from "vitest";
import {
  config,
  middleware,
} from "../../infrastructure/edgeone/agent-middleware";

const environment = {
  VITE_SUPABASE_URL: "https://example.supabase.co",
  VITE_SUPABASE_PUBLISHABLE_KEY: "publishable-key",
};

function request(token?: string): Request {
  return new Request("https://agent.example/rag", {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: JSON.stringify({ message: "你好" }),
  });
}

describe("international Agent middleware", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("matches only the conversational Agent endpoint", () => {
    expect(config).toEqual({ matcher: "/rag" });
  });

  it("rejects requests without a login before invoking the Agent", async () => {
    const next = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await middleware({
      env: environment,
      next,
      request: request(),
    });

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("continues internally and returns the Agent stream unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ id: "user-1" })));
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: text_delta\ndata: {\"delta\":\"你\"}\n\n"));
        controller.close();
      },
    });
    const agentResponse = new Response(stream, {
      headers: { "Content-Type": "text/event-stream" },
    });
    const next = vi.fn(async () => agentResponse);

    const response = await middleware({
      env: environment,
      next,
      request: request("access-token"),
    });

    expect(response).toBe(agentResponse);
    expect(next).toHaveBeenCalledOnce();
    await expect(response.text()).resolves.toContain("event: text_delta");
  });

  it("fails closed for an expired token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    const next = vi.fn();

    const response = await middleware({
      env: environment,
      next,
      request: request("expired-token"),
    });

    expect(response.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});
