import { afterEach, describe, expect, it, vi } from "vitest";
import { onRequest } from "../../infrastructure/edgeone/functions/reader-gateway/[[default]]";

function context(pathname: string) {
  return {
    env: {},
    request: new Request(`https://reader.jojokanbao.cn${pathname}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer reader-token",
        "Content-Type": "application/json",
        "Makers-Conversation-Id": "reader-gateway-test",
        "X-JOJO-Service-Signature": "must-not-forward",
      },
      body: JSON.stringify({ message: "你好" }),
    }),
  } as Parameters<typeof onRequest>[0];
}

describe("Reader Agent gateway", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("relays the same-origin query without forwarding trusted service headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("event: done\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequest(context("/gateway/ask"));

    expect(response.status).toBe(200);
    const [target, init] = fetchMock.mock.calls[0]!;
    expect(String(target)).toBe("https://agent-global.jojokanbao.cn/rag");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer reader-token");
    expect(headers.get("x-jojo-service-signature")).toBeNull();
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe(JSON.stringify({ message: "你好" }));
    await onRequest(context("/gateway/times/explain"));
    expect(String(fetchMock.mock.calls[1]![0])).toBe("https://agent-global.jojokanbao.cn/times");
    expect((await onRequest(context("/gateway/credentials"))).status).toBe(404);
    expect((await onRequest(context("/gateway/unknown"))).status).toBe(404);
  });

  it("rejects unsafe configuration and oversized requests before fetching", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("event: done\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const invalid = context("/gateway/ask");
    invalid.env = { JOJO_AGENT_URL: "http://agent.example/rag" };
    expect((await onRequest(invalid)).status).toBe(503);

    const oversized = context("/gateway/ask");
    oversized.request.headers.set("Content-Length", String(64 * 1024 + 1));
    expect((await onRequest(oversized)).status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();

    const timesRequest = context("/gateway/times/explain");
    timesRequest.env = { JOJO_TIMES_AGENT_URL: "https://times-agent.example/explain" };
    await onRequest(timesRequest);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://times-agent.example/explain");
  });
});
