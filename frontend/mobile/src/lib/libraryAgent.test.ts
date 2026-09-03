import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.hoisted(() => vi.fn());

vi.mock("../account/auth", () => ({
  mobileAuthClient: { auth: { getSession } },
}));

import { askMobileLibraryAgent, boundedMobileAgentHistory, mobileAgentToolActivity } from "./libraryAgent";

describe("mobile library agent", () => {
  beforeEach(() => {
    getSession.mockReset();
    getSession.mockResolvedValue({ data: { session: { access_token: "mobile-token" } }, error: null });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("bounds history and removes citation markers before sending", () => {
    const history = Array.from({ length: 24 }, (_, index) => ({
      role: index % 2 ? "assistant" as const : "user" as const,
      content: `第 ${index} 条[cite:ref_${index}]`,
    }));
    const bounded = boundedMobileAgentHistory(history);
    expect(bounded).toHaveLength(20);
    expect(bounded[0]?.content).toBe("第 4 条");
    expect(bounded.at(-1)?.content).toBe("第 23 条");
  });

  it("turns tool events into plain-language progress", () => {
    expect(mobileAgentToolActivity("search_content", { query: "劳动价值" })).toEqual({
      phase: "searching",
      message: "正在馆藏中检索原文：“劳动价值”",
    });
    expect(mobileAgentToolActivity("read_fragment").phase).toBe("reading");
    expect(mobileAgentToolActivity("search_content", undefined, true).message).toContain("调整检索方式");
  });

  it("streams an all-library question and keeps only cited references", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response([
      'event: tool_end\ndata: {"name":"search_content","references":[{"citationId":"ref_1","itemId":"one"},{"citationId":"ref_2","itemId":"two"}]}',
      'event: text_delta\ndata: {"delta":"回答[cite:ref_2]"}',
      'event: done\ndata: {}',
      "",
    ].join("\n\n"), { headers: { "Content-Type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new Promise<{ id: string; references: Array<{ citationId?: string }> }>((resolve, reject) => {
      askMobileLibraryAgent({
        question: "比较两本书",
        datasetIds: ["book-a", "book-b"],
        scopeMode: "all",
      }, {
        onChunk: vi.fn(),
        onDone: (id, references) => resolve({ id, references }),
        onError: reject,
      });
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init.body))).toMatchObject({
      message: "比较两本书",
      scope: { mode: "all", datasetIds: ["book-a", "book-b"] },
    });
    expect(result.id).toMatch(/^conv_/);
    expect(result.references).toEqual([{ citationId: "ref_2", itemId: "two" }]);
  });
});
