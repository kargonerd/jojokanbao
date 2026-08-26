import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.hoisted(() => vi.fn());

vi.mock("../account/auth", () => ({
  mobileAuthClient: { auth: { getSession } },
}));

import {
  deleteMobileBookAgentConversation,
  getMobileBookAgentConversation,
  listMobileBookAgentConversations,
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

  it("lists only conversations scoped to the current Item", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      conversations: [
        {
          id: "conv_current",
          title: "当前书问题",
          messageCount: 2,
          scope: { itemIds: ["book-a:item-a"] },
        },
        {
          id: "conv_other",
          title: "另一本书问题",
          messageCount: 2,
          scope: { itemIds: ["book-b:item-b"] },
        },
      ],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listMobileBookAgentConversations("book-a:item-a")).resolves.toEqual([
      expect.objectContaining({ id: "conv_current" }),
    ]);
    const [target, init] = fetchMock.mock.calls[0]!;
    expect(String(target)).toBe("https://agent-global.jojokanbao.cn/gateway/conversations?limit=100");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer mobile-token");
  });

  it("restores and deletes a conversation through the international Store API", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        conversation: {
          id: "conv/a",
          title: "历史问题",
          messageCount: 2,
          scope: { itemIds: ["book-a:item-a"] },
        },
        messages: [
          { role: "user", content: "历史问题" },
          { role: "assistant", content: "历史回答", references: [{ targetId: "chapter:1" }] },
        ],
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getMobileBookAgentConversation("conv/a")).resolves.toMatchObject({
      conversation: { id: "conv/a" },
      messages: [{ role: "user" }, { references: [{ targetId: "chapter:1" }] }],
    });
    await deleteMobileBookAgentConversation("conv/a");

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://agent-global.jojokanbao.cn/gateway/conversations/conv%2Fa",
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
  });
});
