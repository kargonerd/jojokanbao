import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { readerExplanationRequest, createReaderExplanation, type ExplanationCallbacks, type ExplanationRequest } from "../src/reader-explanation";


function setup() {
  const requests: Array<{ anchor: string; callbacks: ExplanationCallbacks<{ model: string }>; request: ExplanationRequest; cancel: ReturnType<typeof vi.fn> }> = [];
  const transport = (anchor: string, callbacks: ExplanationCallbacks<{ model: string }>, request: ExplanationRequest) => {
    const cancel = vi.fn();
    requests.push({ anchor, callbacks, request, cancel });
    return cancel;
  };
  const chat = createReaderExplanation(transport);
  act(() => chat.start("ECB"));
  act(() => requests[0]!.callbacks.onDone({ model: "gemini" }, "ECB 是欧洲中央银行。"));
  return { chat, requests };
}

describe("reader explanation conversations", () => {
  it("retains completed turns and the selection, with a stable conversation ID", () => {
    const { chat, requests } = setup();
    act(() => {
      expect(chat.ask("它和美联储有什么区别？")).toBe(true);
      expect(chat.ask("不能重复发送")).toBe(false);
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.anchor).toBe("ECB");
    expect(requests[1]!.request).toEqual({ question: "它和美联储有什么区别？", conversationId: requests[0]!.request.conversationId,
      history: [{ role: "user", content: "请解释选中文字。" }, { role: "assistant", content: "ECB 是欧洲中央银行。" }] });
    act(() => requests[1]!.callbacks.onDone({ model: "gemini" }, "两者分别负责欧元区和美国。"));
    act(() => chat.ask("举个例子"));
    expect(requests[2]!.request.history).toHaveLength(4);
    expect(chat.getSnapshot()?.turns[0]?.answer).toBe("ECB 是欧洲中央银行。");
  });

  it("stops streaming, ignores late callbacks and retries only the pending question", () => {
    const { chat, requests } = setup();
    act(() => chat.ask("它为什么加息？"));
    act(() => requests[1]!.callbacks.onChunk("尚未完成"));
    act(() => chat.stop());
    expect(requests[1]!.cancel).toHaveBeenCalledOnce();
    act(() => { requests[1]!.callbacks.onChunk("迟到的数据"); requests[1]!.callbacks.onDone({ model: "old" }, "不应覆盖"); });
    expect(chat.getSnapshot()?.turns.at(-1)).toMatchObject({ answer: "尚未完成", phase: "stopped" });
    act(() => chat.retry());
    expect(chat.getSnapshot()?.turns).toHaveLength(2);
    expect(requests[2]!.request.question).toBe("它为什么加息？");
    expect(requests[2]!.request.history).toHaveLength(2);
    expect(JSON.stringify(requests[2]!.request.history)).not.toContain("尚未完成");
  });

  it("keeps earlier answers after failure and retries without duplicating the question", () => {
    const { chat, requests } = setup();
    act(() => chat.ask("为什么？"));
    act(() => requests[1]!.callbacks.onError("连接失败"));
    act(() => chat.retry());
    expect(requests[2]!.request).toEqual(requests[1]!.request);
    expect(chat.getSnapshot()?.turns).toHaveLength(2);
    expect(chat.getSnapshot()?.turns.at(-1)).toMatchObject({ error: "", answer: "", phase: "pending" });
  });

  it("clears a closed conversation and ignores its responses after another selection opens", () => {
    const { chat, requests } = setup();
    act(() => chat.ask("后续问题"));
    chat.close();
    expect(requests[1]!.cancel).toHaveBeenCalledOnce();
    expect(chat.getSnapshot()).toBeNull();
    act(() => chat.start("OPEC"));
    act(() => requests[1]!.callbacks.onError("旧请求错误"));
    expect(chat.getSnapshot()?.turns[0]?.error).toBe("");
    chat.close();
    expect(requests[2]!.cancel).toHaveBeenCalledOnce();
  });

  it("keeps fresh reading context and the complete latest question within gateway limits", () => {
    const question = "新".repeat(2_000);
    const payload = readerExplanationRequest("文".repeat(9_800), { question, history: Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user", content: String(index).padEnd(20_000, "旧"),
    })) });
    expect(payload.message.startsWith("文")).toBe(true);
    expect(payload.message.endsWith(question)).toBe(true);
    expect(payload.message.length).toBeLessThanOrEqual(10_000);
    expect(payload.history!.length).toBeLessThanOrEqual(20);
    expect(payload.history![0]?.role).toBe("user");
    expect(payload.history!.reduce((sum, item) => sum + item.content.length, 0)).toBeLessThanOrEqual(100_000);
    expect(payload.history!.at(-1)?.content.startsWith("29")).toBe(true);
  });
});
