import { beforeEach, describe, expect, it, vi } from "vitest";

const authApi = vi.hoisted(() => ({
  getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } }, error: null })),
  rpc: vi.fn(),
}));

vi.mock("../src/account/auth", () => ({
  authClient: {
    auth: { getUser: authApi.getUser },
    rpc: authApi.rpc,
  },
}));

import {
  explanationContextKey,
  phraseKey,
  reusableExplanation,
  saveExplanation,
} from "../src/rag/readerData";

describe("reader data anchors", () => {
  beforeEach(() => authApi.rpc.mockReset());

  it("normalizes equivalent explanation phrases without changing content", () => {
    expect(phraseKey("  ＡＢＣ　革命  ")).toBe("abc 革命");
    expect(explanationContextKey("同一句", "甲的前文", "甲的后文"))
      .not.toBe(explanationContextKey("同一句", "乙的前文", "乙的后文"));
  });

  it("reads and writes the anonymous shared explanation cache", async () => {
    const reference = {
      citationId: "Jfocus",
      datasetId: "book-a",
      itemId: "book-a:item-a",
      targetId: "chapter:1",
    };
    authApi.rpc
      .mockResolvedValueOnce({
        data: [{
          quote: "这段原文",
          answer: "解释[cite:Jfocus]",
          reference_data: [reference],
          query_count: 3,
          prefix: "前文",
          suffix: "后文",
        }],
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null });

    await expect(reusableExplanation(
      "book-a",
      "book-a:item-a",
      "chapter:1",
      "  这段原文  ",
      { prefix: "前文", suffix: "后文" },
    )).resolves.toEqual({
      quote: "这段原文",
      answer: "解释[cite:Jfocus]",
      references: [reference],
      count: 3,
      prefix: "前文",
      suffix: "后文",
    });
    expect(authApi.rpc).toHaveBeenNthCalledWith(1, "get_reader_ai_explanation_cache", {
      p_dataset_id: "book-a",
      p_item_id: "book-a:item-a",
      p_chapter_id: "chapter:1",
      p_context_key: '["前文","这段原文","后文"]',
      p_prompt_version: "reader-focus-v1",
    });

    await saveExplanation({
      datasetId: "book-a",
      itemId: "book-a:item-a",
      chapterId: "chapter:1",
      quote: "这段原文",
      prefix: "前文",
      suffix: "后文",
      answer: "解释[cite:Jfocus]",
      references: [reference],
      metadata: { provider: "openai-codex", model: "gpt-test" },
    });
    expect(authApi.rpc).toHaveBeenNthCalledWith(2, "put_reader_ai_explanation_cache", expect.objectContaining({
      p_context_key: '["前文","这段原文","后文"]',
      p_prefix: "前文",
      p_suffix: "后文",
      p_references: [reference],
      p_model: "openai-codex/gpt-test",
      p_prompt_version: "reader-focus-v1",
    }));
    expect(JSON.stringify(authApi.rpc.mock.calls)).not.toContain("user-1");
  });
});
