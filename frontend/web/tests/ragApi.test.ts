import { afterEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

vi.mock("../src/account/auth", () => ({
  authClient: {
    auth: {
      getSession: authMocks.getSession,
    },
  },
}));

import { askStream } from "../src/rag/api";

afterEach(() => {
  vi.restoreAllMocks();
  authMocks.getSession.mockReset();
});

describe("RAG Agent SSE client", () => {
  it("sends the JOJO session and reads Agent event names, usage, and cost", async () => {
    authMocks.getSession.mockResolvedValue({
      data: { session: { access_token: "access-token" } },
      error: null,
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(
          'event: status\ndata: {"conversationId":"conversation-001"}\n\n'
          + 'event: text_delta\ndata: {"delta":"第一段"}\n\n',
        ));
        controller.enqueue(encoder.encode(
          'event: text_delta\ndata: {"delta":"第二段"}\n\n'
          + 'event: done\ndata: {"conversationId":"conversation-001",'
          + '"usage":{"inputTokens":10,"outputTokens":2,"cacheReadTokens":0,'
          + '"cacheWriteTokens":0,"totalTokens":12,"cost":{"input":0.01,'
          + '"output":0.01,"cacheRead":0,"cacheWrite":0,"total":0.02}}}\n\n',
        ));
        controller.close();
      },
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const result = await new Promise<{
      text: string;
      conversationId?: string;
      totalTokens?: number;
      cost?: number;
    }>((resolve, reject) => {
      let text = "";
      askStream(
        {
          notebook_id: "notebook-1",
          question: "问题",
          source_ids: ["source-1"],
        },
        (chunk) => {
          text += chunk;
        },
        (done) => resolve({
          text,
          conversationId: done.conversationId,
          totalTokens: done.usage?.totalTokens,
          cost: done.usage?.cost.total,
        }),
        reject,
      );
    });

    expect(result).toEqual({
      text: "第一段第二段",
      conversationId: "conversation-001",
      totalTokens: 12,
      cost: 0.02,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/rag/chat/stream",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer access-token",
        }),
      }),
    );
  });
});
