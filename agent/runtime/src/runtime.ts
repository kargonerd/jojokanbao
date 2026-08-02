import { runAgentLoop } from "@earendil-works/pi-agent-core";
import type {
  AgentContext,
  AgentEvent,
  AgentMessage,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
  defaultMessageConverter,
  type AgentUsage,
  type PlatformAgentResult,
  type RunPlatformAgentOptions,
} from "./types";

const DEFAULT_MAX_TURNS = 8;
const DEFAULT_MAX_TOOL_CALLS = 20;

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function addUsage(target: Usage, source: Usage): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  if (source.cacheWrite1h !== undefined) {
    target.cacheWrite1h = (target.cacheWrite1h ?? 0) + source.cacheWrite1h;
  }
  if (source.reasoning !== undefined) {
    target.reasoning = (target.reasoning ?? 0) + source.reasoning;
  }
  target.totalTokens += source.totalTokens;
  target.cost.input += source.cost.input;
  target.cost.output += source.cost.output;
  target.cost.cacheRead += source.cost.cacheRead;
  target.cost.cacheWrite += source.cost.cacheWrite;
  target.cost.total += source.cost.total;
}

function publicUsage(usage: Usage): AgentUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    ...(usage.cacheWrite1h === undefined
      ? {}
      : { cacheWrite1hTokens: usage.cacheWrite1h }),
    ...(usage.reasoning === undefined
      ? {}
      : { reasoningTokens: usage.reasoning }),
    totalTokens: usage.totalTokens,
    cost: { ...usage.cost },
  };
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return message.role === "assistant";
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("");
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return resolved;
}

function promptMessages(prompt: RunPlatformAgentOptions["prompt"]): AgentMessage[] {
  if (typeof prompt !== "string") {
    if (prompt.length === 0) throw new Error("prompt must contain at least one message");
    return [...prompt];
  }
  if (!prompt.trim()) throw new Error("prompt must not be empty");
  return [{ role: "user", content: prompt, timestamp: Date.now() }];
}

function terminalError(stopReason: "error" | "aborted", message?: string): Error {
  const error = new Error(
    message || (stopReason === "aborted" ? "model call aborted" : "model call failed"),
  );
  if (stopReason === "aborted") error.name = "AbortError";
  return error;
}

export async function runPlatformAgent(
  options: RunPlatformAgentOptions,
): Promise<PlatformAgentResult> {
  const startedAt = Date.now();
  const maxTurns = positiveInteger(options.maxTurns, DEFAULT_MAX_TURNS, "maxTurns");
  const maxToolCalls = positiveInteger(
    options.maxToolCalls,
    DEFAULT_MAX_TOOL_CALLS,
    "maxToolCalls",
  );
  const usage = emptyUsage();
  let turns = 0;
  let toolCalls = 0;
  let failure: Error | undefined;

  const context: AgentContext = {
    systemPrompt: options.systemPrompt,
    messages: [...(options.history ?? [])],
    tools: [...(options.tools ?? [])],
  };

  const emit = async (event: AgentEvent) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      await options.onEvent?.({ type: "text_delta", delta: event.assistantMessageEvent.delta });
      return;
    }

    if (event.type === "tool_execution_start") {
      await options.onEvent?.({
        type: "tool_start",
        callId: event.toolCallId,
        name: event.toolName,
        args: event.args,
      });
      return;
    }

    if (event.type === "tool_execution_end") {
      await options.onEvent?.({
        type: "tool_end",
        callId: event.toolCallId,
        name: event.toolName,
        isError: event.isError,
      });
      return;
    }

    if (event.type === "turn_end") {
      turns += 1;
      await options.onEvent?.({ type: "turn_end", turn: turns });
      return;
    }

    if (event.type === "message_end" && isAssistantMessage(event.message)) {
      addUsage(usage, event.message.usage);
      if (
        event.message.stopReason === "error"
        || event.message.stopReason === "aborted"
      ) {
        failure = terminalError(
          event.message.stopReason,
          event.message.errorMessage,
        );
      }
      await options.onEvent?.({ type: "usage", usage: publicUsage(usage) });
    }
  };

  const messages = await runAgentLoop(
    promptMessages(options.prompt),
    context,
    {
      model: options.model,
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.getApiKey === undefined ? {} : { getApiKey: options.getApiKey }),
      ...(options.reasoning ? { reasoning: options.reasoning } : {}),
      toolExecution: options.toolExecution ?? "parallel",
      convertToLlm: options.convertToLlm ?? defaultMessageConverter,
      beforeToolCall: async (toolContext, signal) => {
        if (toolCalls >= maxToolCalls) {
          return { block: true, reason: `tool call budget exceeded (${maxToolCalls})` };
        }
        toolCalls += 1;
        return options.beforeToolCall?.(toolContext, signal);
      },
      shouldStopAfterTurn: async (turnContext) => {
        if (turns >= maxTurns) return true;
        return (await options.shouldStopAfterTurn?.(turnContext)) ?? false;
      },
    },
    emit,
    options.signal,
    options.stream,
  );

  if (failure) throw failure;

  const answer = [...messages]
    .reverse()
    .find(isAssistantMessage);

  return {
    answer: answer ? assistantText(answer) : "",
    messages,
    usage: publicUsage(usage),
    turns,
    toolCalls,
    durationMs: Date.now() - startedAt,
  };
}
