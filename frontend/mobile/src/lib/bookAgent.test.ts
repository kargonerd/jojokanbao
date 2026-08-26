import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.hoisted(() => vi.fn());

vi.mock("../account/auth", () => ({
  mobileAuthClient: { auth: { getSession } },
}));

import {
  askMobileBookAgent,
  parseAgentSseFrames,
} from "./bookAgent";

describe("mobile book agent stream", () => {
  beforeEach(() => {
    getSession.mockReset();
    getSession.mockResolvedValue({
      data: { session: { access_token: "mobile-token" } },
      error: null,
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("parses complete SSE frames and preserves a partial frame", () => {
    const listener = vi.fn();
    const remainder = parseAgentSseFrames(
      'event: text_delta\ndata: {"delta":"回答"}\n\nevent: done\ndata: {',
      listener,
    );
    expect(listener).toHaveBeenCalledWith("text_delta", { delta: "回答" });
    expect(remainder).toBe("event: done\ndata: {");
  });

  it("sends recent client history with the streamed question", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      'event: text_delta\ndata: {"delta":"回答"}\n\nevent: done\ndata: {}\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    await new Promise<void>((resolve, reject) => {
      askMobileBookAgent({
        datasetId: "book-a",
        itemId: "book-a:item-a",
        manifestObject: "content/book-a/manifest.jox",
        question: "继续解释",
        conversationId: "conv_test",
        history: [
          { role: "user", content: "上一问" },
          { role: "assistant", content: "上一答[cite:ref_1]" },
        ],
      }, vi.fn(), () => resolve(), reject);
    });

    const [target, init] = fetchMock.mock.calls[0]!;
    expect(String(target)).toBe("https://agent-global.jojokanbao.cn/rag");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer mobile-token");
    expect(JSON.parse(String(init.body))).toMatchObject({
      message: "继续解释",
      history: [
        { role: "user", content: "上一问" },
        { role: "assistant", content: "上一答" },
      ],
    });
  });
});
