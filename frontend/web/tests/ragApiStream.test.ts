import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/account/auth", () => ({
  authClient: {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { access_token: "test-token" } },
        error: null,
      }),
    },
  },
}));

import { askStream } from "../src/rag/api";
import type { RagReference } from "../src/rag/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("askStream references", () => {
  it("sends recent client history without stale citation ids", async () => {
    const frame = (event: string, payload: unknown) => (
      `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
    );
    const fetchMock = vi.fn().mockResolvedValue(new Response(frame("done", {})));
    globalThis.fetch = fetchMock as typeof fetch;

    await new Promise<void>((resolve, reject) => {
      askStream({
        datasetIds: ["book-a"],
        scopeMode: "all",
        question: "继续解释",
        history: [
          { role: "user", content: "上一问" },
          { role: "assistant", content: "上一答[cite:Jold]" },
        ],
      }, () => undefined, () => resolve(), reject);
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      message: "继续解释",
      history: [
        { role: "user", content: "上一问" },
        { role: "assistant", content: "上一答" },
      ],
    });
  });

  it("keeps exact and chapter-level locations until the answer selects its citations", async () => {
    const anchored = {
      datasetId: "book-a",
      itemId: "book-a:item-a",
      targetId: "chapter:1",
      anchorId: "jojo-search-block:chapter:1:7",
      title: "第一章",
      excerpt: "劳动创造价值",
      fragmentObject: "content/books/book-a/items/item-a/chapters/one.jox",
    };
    const generic = {
      datasetId: anchored.datasetId,
      itemId: anchored.itemId,
      targetId: anchored.targetId,
      title: anchored.title,
      fragmentObject: anchored.fragmentObject,
    };
    const frame = (event: string, payload: unknown) => (
      `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
    );
    globalThis.fetch = vi.fn().mockResolvedValue(new Response([
      frame("tool_end", { references: [anchored] }),
      frame("tool_end", { references: [generic] }),
      frame("done", {}),
    ].join(""))) as typeof fetch;

    const references = await new Promise<RagReference[]>((resolve, reject) => {
      askStream({
        datasetIds: [],
        scopeMode: "all",
        question: "什么是剩余价值",
        conversationId: "conv_test",
      }, () => undefined, (result) => resolve(result ?? []), reject);
    });

    expect(references).toEqual([anchored, generic]);
  });

  it("returns only source locations explicitly cited by the final answer", async () => {
    const used = { citationId: "Jused", datasetId: "book-a", itemId: "volume-a", targetId: "chapter:1", anchorId: "p:1" };
    const unused = { citationId: "Junused", datasetId: "book-a", itemId: "volume-a", targetId: "chapter:2", anchorId: "p:2" };
    const frame = (event: string, payload: unknown) => (
      `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
    );
    globalThis.fetch = vi.fn().mockResolvedValue(new Response([
      frame("tool_end", { references: [used, unused] }),
      frame("text_delta", { delta: "结论[cite:Jused]" }),
      frame("done", {}),
    ].join(""))) as typeof fetch;

    const references = await new Promise<RagReference[]>((resolve, reject) => {
      askStream({ datasetIds: [], scopeMode: "all", question: "问题" }, () => undefined, (result) => resolve(result ?? []), reject);
    });

    expect(references).toEqual([used]);
  });

  it("reports real Agent and tool activity from the SSE stream", async () => {
    const frame = (event: string, payload: unknown) => (
      `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
    );
    globalThis.fetch = vi.fn().mockResolvedValue(new Response([
      frame("status", { model: "test" }),
      frame("tool_start", { name: "search_content", args: { query: "剩余价值" } }),
      frame("tool_end", { name: "search_content", isError: false }),
      frame("tool_start", { name: "read_fragment", args: {} }),
      frame("text_delta", { delta: "回答" }),
      frame("done", {}),
    ].join(""))) as typeof fetch;

    const activities: string[] = [];
    await new Promise<void>((resolve, reject) => {
      askStream({
        datasetIds: [],
        scopeMode: "all",
        question: "什么是剩余价值",
        conversationId: "conv_activity",
      }, () => undefined, () => resolve(), reject, (activity) => {
        activities.push(activity.message);
      });
    });

    expect(activities).toEqual(expect.arrayContaining([
      "正在确认登录状态…",
      "JOJO 正在连接馆藏…",
      "正在分析问题并选择资料…",
      "正在候选书籍中检索原文：“剩余价值”",
      "已取得一批资料，正在判断是否需要继续查找…",
      "正在读取命中的相关章节…",
      "正在根据原文组织回答…",
    ]));
  });
});
