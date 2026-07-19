import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import {
  Type,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { runPlatformAgent, type PlatformAgentEvent } from "../src";

describe("runPlatformAgent", () => {
  it("runs a Pi tool loop and exposes product-neutral events", async () => {
    const faux = fauxProvider({ provider: "jojo-test", tokensPerSecond: 100_000 });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("multiply", { left: 6, right: 7 })),
      fauxAssistantMessage("42"),
    ]);

    const parameters = Type.Object({ left: Type.Number(), right: Type.Number() });
    const execute = vi.fn(async (_callId: string, args: { left: number; right: number }) => ({
      content: [{ type: "text" as const, text: String(args.left * args.right) }],
      details: { result: args.left * args.right },
    }));
    const tool: AgentTool<typeof parameters> = {
      name: "multiply",
      label: "Multiply",
      description: "Multiply two numbers",
      parameters,
      execute,
    };
    const events: PlatformAgentEvent[] = [];
    const stream: StreamFn = (model, context, options) =>
      faux.provider.streamSimple(model, context, options);

    const result = await runPlatformAgent({
      systemPrompt: "Use the multiply tool.",
      prompt: "What is 6 times 7?",
      tools: [tool],
      model: faux.getModel(),
      stream,
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(result.answer).toBe("42");
    expect(result.turns).toBe(2);
    expect(result.toolCalls).toBe(1);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool_start", name: "multiply" }),
      expect.objectContaining({ type: "tool_end", name: "multiply", isError: false }),
      expect.objectContaining({ type: "text_delta", delta: "42" }),
      expect.objectContaining({ type: "usage" }),
    ]));
  });

  it("stops after the configured turn budget", async () => {
    const faux = fauxProvider({ provider: "jojo-budget-test", tokensPerSecond: 100_000 });
    faux.setResponses([
      fauxAssistantMessage("first turn"),
      fauxAssistantMessage("second turn"),
    ]);
    const stream: StreamFn = (model, context, options) =>
      faux.provider.streamSimple(model, context, options);

    const result = await runPlatformAgent({
      systemPrompt: "Answer briefly.",
      prompt: "Hello",
      model: faux.getModel(),
      stream,
      maxTurns: 1,
    });

    expect(result.answer).toBe("first turn");
    expect(result.turns).toBe(1);
  });
});
