import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onRequest } from "../../infrastructure/edgeone/functions/ask/index";
import { onRequest as onTimesRequest } from "../../infrastructure/edgeone/functions/ask/times";
import {
  DEFAULT_AGENT_ASK_URL,
  DEFAULT_AGENT_TIMES_URL,
  relayAskRequest,
} from "../../agent/src/edgeone/relay";

function context(
  pathname: string,
  init: RequestInit = {},
  env: Record<string, string | undefined> = {},
) {
  return {
    env,
    request: new Request(`https://agent-global.jojokanbao.cn${pathname}`, init),
  } as Parameters<typeof onRequest>[0];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("edge runtime constraints", () => {
  it("never calls Response.json, which fails with HTTP 545 on EdgeOne", async () => {
    // The EdgeOne edge runtime throws on `Response.json(...)`: the request dies
    // with 545 "Error return from script". Verified on a live preview — a
    // handler branch using `Response.json()` returned 545 while
    // `new Response(JSON.stringify(...))` on the same route returned its status
    // normally. Every JSON response must therefore be hand-built.
    const source = await readFile(
      new URL("../../agent/src/edgeone/relay.ts", import.meta.url),
      "utf8",
    );
    const code = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("*"))
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/Response\.json\s*\(/u);
  });

  it("emits JSON responses with an explicit charset through the hand-rolled helper", async () => {
    vi.stubGlobal("fetch", vi.fn());

    const response = await onRequest(context("/ask", { method: "GET" }));

    expect(response.status).toBe(405);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    await expect(response.json()).resolves.toEqual({ error: "Method not allowed" });
  });
});

describe("unified Agent entry point", () => {
  it("answers the browser preflight itself instead of letting the platform 400 it", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest(context("/ask", {
      method: "OPTIONS",
      headers: {
        Origin: "https://reader.jojokanbao.cn",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type,makers-conversation-id",
      },
    }));

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://reader.jojokanbao.cn");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("authorization");
    // The platform gate on `/rag` is never reached: no upstream call at all.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards a POST to the internal Makers route and streams the response back", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: text_delta\ndata: {"delta":"你"}\n\n'));
        controller.enqueue(new TextEncoder().encode("event: done\ndata: {}\n\n"));
        controller.close();
      },
    });
    const fetchSpy = vi.fn().mockResolvedValue(new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "x-request-id": "upstream-1",
        "set-cookie": "must-not-leak=1",
      },
    }));
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest(context("/ask", {
      method: "POST",
      headers: {
        Origin: "https://reader.jojokanbao.cn",
        Authorization: "Bearer reader-token",
        "Content-Type": "application/json",
        "Makers-Conversation-Id": "conversation-1",
        Cookie: "must-not-forward=1",
      },
      body: JSON.stringify({ message: "测试" }),
    }));

    const [target, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
    expect(String(target)).toBe(DEFAULT_AGENT_ASK_URL);
    const forwarded = new Headers(init.headers);
    expect(forwarded.get("Authorization")).toBe("Bearer reader-token");
    expect(forwarded.get("Makers-Conversation-Id")).toBe("conversation-1");
    expect(forwarded.get("Cookie")).toBeNull();
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe('{"message":"测试"}');

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("x-request-id")).toBe("upstream-1");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).toContain("event: done");
  });

  it("routes Times requests to the internal times route", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(
      "event: done\ndata: {}\n\n",
      { headers: { "content-type": "text/event-stream" } },
    ));
    vi.stubGlobal("fetch", fetchSpy);

    await onTimesRequest(context("/ask/times", {
      method: "POST",
      body: JSON.stringify({ message: "测试" }),
    }));

    expect(String(fetchSpy.mock.calls[0]![0])).toBe(DEFAULT_AGENT_TIMES_URL);
  });

  it("rejects non-POST methods and oversized bodies before any upstream call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    expect((await onRequest(context("/ask", { method: "GET" }))).status).toBe(405);
    expect((await onRequest(context("/ask", {
      method: "POST",
      body: "x".repeat(64 * 1024 + 1),
    }))).status).toBe(413);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("omits CORS headers for an origin that is not allow-listed", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest(context("/ask", {
      method: "OPTIONS",
      headers: { Origin: "https://attacker.example" },
    }));

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Vary")).toBe("Origin");
  });

  it("surfaces the upstream failure detail on the response when the relay cannot connect", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), {
          code: "ENOTFOUND",
          hostname: "agent-global.jojokanbao.cn",
        }),
      }),
    ));

    const response = await relayAskRequest(context("/ask", { method: "POST", body: "{}" }));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "问答服务暂时不可用" });
    expect(decodeURIComponent(response.headers.get("X-JOJO-Relay-Failure") ?? ""))
      .toContain("ENOTFOUND");
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
