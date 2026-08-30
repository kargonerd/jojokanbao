import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import {
  Type,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { runPlatformAgent, type PlatformAgentEvent } from "../src";
import { answerSourceReferences, toolSourceReferences } from "../src/runtime";

describe("runPlatformAgent", () => {
  it("keeps only references explicitly used by the answer", () => {
    const references = [
      { citationId: "Jused", targetId: "chapter:1" },
      { citationId: "Junused", targetId: "chapter:2" },
    ];
    expect(answerSourceReferences("结论[cite:Jused]", references)).toEqual([references[0]]);
  });

  it("exposes compact source locations without streaming full tool results", () => {
    expect(toolSourceReferences({
      details: {
        hits: [{ citationId: "Jchapter2", datasetId: "books", datasetTitle: "测试书库", itemId: "book:one", itemTitle: "第一卷", targetId: "chapter:2", anchorId: "paragraph:7", targetTitle: "第二章", text: "命中正文", fragmentObject: "content/books/one/chapter-2.jox" }],
      },
    })).toEqual([{
      citationId: "Jchapter2",
      datasetId: "books",
      datasetTitle: "测试书库",
      itemId: "book:one",
      itemTitle: "第一卷",
      targetId: "chapter:2",
      anchorId: "paragraph:7",
      title: "第二章",
      excerpt: "命中正文",
      fragmentObject: "content/books/one/chapter-2.jox",
    }]);
    expect(toolSourceReferences({
      details: {
        datasetId: "books",
        itemId: "book:one",
        entries: [{ targetId: "chapter:3", title: "第三章" }],
      },
    })).toEqual([]);
  });

  it("runs a Pi tool loop and exposes product-neutral events", async () => {
    const faux = fauxProvider({ provider: "jojo-test", tokensPerSecond: 100_000 });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("multiply", { left: 6, right: 7 })),
      fauxAssistantMessage("42"),
    ]);

    const parameters = Type.Object({ left: Type.Number(), right: Type.Number() });
    const execute = vi.fn(async (_callId: string, args: { left: number; right: number }) => ({
      content: [{ type: "text" as const, text: String(args.left * args.right) }],
      details: {
        result: args.left * args.right,
        datasetId: "books",
        itemId: "book:one",
        targetId: "chapter:2",
        title: "第二章",
        text: "六乘以七等于四十二",
      },
    }));
    const tool: AgentTool<typeof parameters> = {
      name: "multiply",
      label: "Multiply",
      description: "Multiply two numbers",
      parameters,
      execute,
    };
    const events: PlatformAgentEvent[] = [];
    let receivedSessionId: string | undefined;
    const stream: StreamFn = (model, context, options) => {
      receivedSessionId = options?.sessionId;
      return faux.provider.streamSimple(model, context, options);
    };

    const result = await runPlatformAgent({
      systemPrompt: "Use the multiply tool.",
      prompt: "What is 6 times 7?",
      sessionId: "conversation-cache-key",
      tools: [tool],
      model: faux.getModel(),
      stream,
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(receivedSessionId).toBe("conversation-cache-key");
    expect(result.answer).toBe("42");
    expect(result.stopReason).toBe("stop");
    expect(result.turns).toBe(2);
    expect(result.toolCalls).toBe(1);
    expect(result.references).toEqual([{
      citationId: expect.stringMatching(/^J[a-z0-9]+$/),
      datasetId: "books",
      itemId: "book:one",
      targetId: "chapter:2",
      title: "第二章",
      excerpt: "六乘以七等于四十二",
    }]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool_start", name: "multiply" }),
      expect.objectContaining({ type: "tool_end", name: "multiply", isError: false }),
      expect.objectContaining({ type: "text_delta", delta: "42" }),
      expect.objectContaining({ type: "usage" }),
    ]));
  });

  it("reports when the provider stops at its output limit", async () => {
    const faux = fauxProvider({ provider: "jojo-length-test", tokensPerSecond: 100_000 });
    faux.setResponses([fauxAssistantMessage("partial answer", { stopReason: "length" })]);

    const result = await runPlatformAgent({
      systemPrompt: "Answer briefly.",
      prompt: "Hello",
      model: faux.getModel(),
      stream: (model, context, options) =>
        faux.provider.streamSimple(model, context, options),
    });

    expect(result.answer).toBe("partial answer");
    expect(result.stopReason).toBe("length");
  });

  it("continues a truncated text answer when the product enables it", async () => {
    const faux = fauxProvider({ provider: "jojo-length-continuation-test", tokensPerSecond: 100_000 });
    faux.setResponses([
      fauxAssistantMessage("第一段未完", { stopReason: "length" }),
      fauxAssistantMessage("，这里接着完成。\n<!-- JOJO_TIMES_COMPLETE -->"),
    ]);

    const result = await runPlatformAgent({
      systemPrompt: "Explain the selection.",
      prompt: "Explain this.",
      model: faux.getModel(),
      stream: faux.provider.streamSimple,
      maxLengthContinuations: 1,
    });

    expect(result.answer).toBe("第一段未完，这里接着完成。\n<!-- JOJO_TIMES_COMPLETE -->");
    expect(result.stopReason).toBe("stop");
    expect(result.turns).toBe(2);
    expect(faux.state.callCount).toBe(2);
  });

  it("rejects an unfinished tool loop after the configured turn budget", async () => {
    const faux = fauxProvider({ provider: "jojo-budget-test", tokensPerSecond: 100_000 });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", { value: "first" })),
      fauxAssistantMessage("should not run"),
    ]);
    const parameters = Type.Object({ value: Type.String() });
    const tool: AgentTool<typeof parameters> = {
      name: "echo",
      label: "Echo",
      description: "Echo a value",
      parameters,
      execute: async (_callId, args) => ({
        content: [{ type: "text", text: args.value }],
        details: args,
      }),
    };
    const stream: StreamFn = (model, context, options) =>
      faux.provider.streamSimple(model, context, options);

    await expect(runPlatformAgent({
      systemPrompt: "Answer briefly.",
      prompt: "Hello",
      tools: [tool],
      model: faux.getModel(),
      stream,
      maxTurns: 1,
    })).rejects.toMatchObject({
      name: "AgentBudgetError",
      message: "本次回答步骤过多，请缩小问题范围后重试（1）",
    });
  });

  it("blocks excess tool calls without reporting a count above the budget", async () => {
    const faux = fauxProvider({ provider: "jojo-tool-budget-test", tokensPerSecond: 100_000 });
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("echo", { value: "first" }, { id: "call-1" }),
        fauxToolCall("echo", { value: "second" }, { id: "call-2" }),
      ]),
      fauxAssistantMessage("done"),
    ]);

    const parameters = Type.Object({ value: Type.String() });
    const execute = vi.fn(async (_callId: string, args: { value: string }) => ({
      content: [{ type: "text" as const, text: args.value }],
      details: args,
    }));
    const tool: AgentTool<typeof parameters> = {
      name: "echo",
      label: "Echo",
      description: "Echo a value",
      parameters,
      execute,
    };
    const events: PlatformAgentEvent[] = [];

    const result = await runPlatformAgent({
      systemPrompt: "Use the echo tool.",
      prompt: "Echo two values.",
      tools: [tool],
      model: faux.getModel(),
      stream: (model, context, options) =>
        faux.provider.streamSimple(model, context, options),
      maxToolCalls: 1,
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(result.answer).toBe("done");
    expect(result.toolCalls).toBe(1);
    expect(events.filter((event) => event.type === "tool_end")).toEqual(expect.arrayContaining([
      expect.objectContaining({ callId: "call-1", isError: false }),
      expect.objectContaining({ callId: "call-2", isError: true }),
    ]));
  });

  it("resolves short-lived credentials before each model request", async () => {
    const faux = fauxProvider({ provider: "jojo-credential-test", tokensPerSecond: 100_000 });
    faux.setResponses([fauxAssistantMessage("authenticated")]);
    const getApiKey = vi.fn(async () => "fresh-token");
    let observedApiKey: string | undefined;

    const result = await runPlatformAgent({
      systemPrompt: "Answer briefly.",
      prompt: "Hello",
      model: faux.getModel(),
      apiKey: "stale-token",
      getApiKey,
      stream: (model, context, options) => {
        observedApiKey = options?.apiKey;
        return faux.provider.streamSimple(model, context, options);
      },
    });

    expect(result.answer).toBe("authenticated");
    expect(getApiKey).toHaveBeenCalledWith("jojo-credential-test");
    expect(observedApiKey).toBe("fresh-token");
  });

  it("rejects model cancellation as an AbortError", async () => {
    const faux = fauxProvider({ provider: "jojo-abort-test", tokensPerSecond: 100_000 });
    faux.setResponses([
      fauxAssistantMessage("", {
        stopReason: "aborted",
        errorMessage: "request cancelled",
      }),
    ]);

    await expect(runPlatformAgent({
      systemPrompt: "Answer briefly.",
      prompt: "Hello",
      model: faux.getModel(),
      stream: (model, context, options) =>
        faux.provider.streamSimple(model, context, options),
    })).rejects.toMatchObject({
      name: "AbortError",
      message: "request cancelled",
    });
  });

  it("rejects model errors instead of returning a successful result", async () => {
    const faux = fauxProvider({ provider: "jojo-error-test", tokensPerSecond: 100_000 });
    faux.setResponses([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "provider unavailable",
      }),
    ]);

    await expect(runPlatformAgent({
      systemPrompt: "Answer briefly.",
      prompt: "Hello",
      model: faux.getModel(),
      stream: (model, context, options) =>
        faux.provider.streamSimple(model, context, options),
    })).rejects.toThrow("provider unavailable");
  });

  it("rejects an empty prompt message list before calling the provider", async () => {
    const faux = fauxProvider({ provider: "jojo-empty-prompt-test", tokensPerSecond: 100_000 });
    const stream = vi.fn((model, context, options) =>
      faux.provider.streamSimple(model, context, options));

    await expect(runPlatformAgent({
      systemPrompt: "Answer briefly.",
      prompt: [],
      model: faux.getModel(),
      stream,
    })).rejects.toThrow("prompt must contain at least one message");
    expect(stream).not.toHaveBeenCalled();
  });
});
