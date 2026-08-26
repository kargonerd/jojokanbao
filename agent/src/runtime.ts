import { Agent } from "@earendil-works/pi-agent-core";
import type {
  AgentEvent,
  AgentMessage,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
  defaultMessageConverter,
  type AgentUsage,
  type AgentSourceReference,
  type PlatformAgentResult,
  type RunPlatformAgentOptions,
} from "./types";
import { citationIdForLocation } from "./citations";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function sourceReference(
  value: unknown,
  inherited: Record<string, unknown> = {},
): AgentSourceReference | undefined {
  if (!isRecord(value)) return undefined;
  const targetId = stringField(value.targetId) ?? stringField(value.chapterId);
  if (!targetId) return undefined;
  const source = isRecord(value.source) ? value.source : undefined;
  const excerpt = stringField(value.text);
  const citationId = stringField(value.citationId) ?? citationIdForLocation(value);
  return {
    ...(citationId ? { citationId } : {}),
    ...(stringField(value.datasetId) || stringField(inherited.datasetId)
      ? { datasetId: stringField(value.datasetId) ?? stringField(inherited.datasetId) }
      : {}),
    ...(stringField(value.itemId) || stringField(inherited.itemId)
      ? { itemId: stringField(value.itemId) ?? stringField(inherited.itemId) }
      : {}),
    ...(stringField(value.datasetTitle) || stringField(inherited.datasetTitle)
      ? { datasetTitle: stringField(value.datasetTitle) ?? stringField(inherited.datasetTitle) }
      : {}),
    ...(stringField(value.itemTitle) || stringField(inherited.itemTitle)
      ? { itemTitle: stringField(value.itemTitle) ?? stringField(inherited.itemTitle) }
      : {}),
    targetId,
    ...(stringField(value.anchorId) ? { anchorId: stringField(value.anchorId) } : {}),
    ...(stringField(value.targetTitle) || stringField(value.title)
      ? { title: stringField(value.targetTitle) ?? stringField(value.title) }
      : {}),
    ...(excerpt ? { excerpt: excerpt.slice(0, 320) } : {}),
    ...(stringField(value.fragmentObject) || stringField(source?.fragmentObject)
      ? { fragmentObject: stringField(value.fragmentObject) ?? stringField(source?.fragmentObject) }
      : {}),
  };
}

function storeSourceReference(
  references: Map<string, AgentSourceReference>,
  reference: AgentSourceReference,
): void {
  const key = [
    reference.datasetId || "",
    reference.itemId || "",
    reference.targetId,
    reference.anchorId || "",
  ].join("\0");
  references.set(key, { ...references.get(key), ...reference });
}

export function answerSourceReferences(
  answer: string,
  references: AgentSourceReference[],
): AgentSourceReference[] {
  const citationIds = [...answer.matchAll(/\[cite:([A-Za-z0-9_-]+)\]/g)]
    .map((match) => match[1])
    .filter((citationId): citationId is string => Boolean(citationId));
  if (!citationIds.length) return references;
  const byCitationId = new Map(references.flatMap((reference) => reference.citationId
    ? [[reference.citationId, reference] as const]
    : []));
  return [...new Set(citationIds)].flatMap((citationId) => {
    const reference = byCitationId.get(citationId);
    return reference ? [reference] : [];
  });
}

export function toolSourceReferences(result: unknown): AgentSourceReference[] {
  if (!isRecord(result)) return [];
  const details = isRecord(result.details) ? result.details : result;
  const candidates = [
    ...(Array.isArray(details.hits) ? details.hits : []),
    ...(Array.isArray(details.evidence) ? details.evidence : []),
    details,
  ];
  const references = new Map<string, AgentSourceReference>();
  for (const candidate of candidates) {
    const reference = sourceReference(candidate, details);
    if (!reference) continue;
    storeSourceReference(references, reference);
    if (references.size >= 8) break;
  }
  return [...references.values()];
}

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

function hasToolCall(message: AssistantMessage): boolean {
  return message.content.some((item) => item.type === "toolCall");
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

function budgetError(maxTurns: number): Error {
  const error = new Error(`本次回答步骤过多，请缩小问题范围后重试（${maxTurns}）`);
  error.name = "AgentBudgetError";
  return error;
}

/**
 * Run one product-neutral Agent invocation.
 *
 * Pi's high-level Agent owns the transcript, model/tool loop, event ordering,
 * cancellation and tool execution. This adapter only applies JOJO's public
 * event/result shape and request budgets.
 */
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
  const initialMessages = [...(options.history ?? [])];
  const usage = emptyUsage();
  let turns = 0;
  let toolCalls = 0;
  let failure: Error | undefined;
  const sourceReferences = new Map<string, AgentSourceReference>();

  if (options.signal?.aborted) {
    throw terminalError("aborted", "回答已停止");
  }

  const agent = new Agent({
    sessionId: options.sessionId,
    initialState: {
      systemPrompt: options.systemPrompt,
      messages: initialMessages,
      tools: [...(options.tools ?? [])],
      model: options.model,
      thinkingLevel: options.reasoning ?? "off",
    },
    streamFn: options.stream,
    convertToLlm: options.convertToLlm ?? defaultMessageConverter,
    getApiKey: options.getApiKey
      ?? (options.apiKey === undefined ? undefined : async () => options.apiKey),
    toolExecution: options.toolExecution ?? "parallel",
    beforeToolCall: async (toolContext, signal) => {
      if (toolCalls >= maxToolCalls) {
        return { block: true, reason: `tool call budget exceeded (${maxToolCalls})` };
      }
      toolCalls += 1;
      return options.beforeToolCall?.(toolContext, signal);
    },
    prepareNextTurnWithContext: options.prepareNextTurn,
  });

  const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      await options.onEvent?.({
        type: "text_delta",
        delta: event.assistantMessageEvent.delta,
      });
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
      const references = toolSourceReferences(event.result);
      for (const reference of references) {
        storeSourceReference(sourceReferences, reference);
      }
      await options.onEvent?.({
        type: "tool_end",
        callId: event.toolCallId,
        name: event.toolName,
        isError: event.isError,
        ...(references.length ? { references } : {}),
      });
      return;
    }

    if (event.type === "message_end" && isAssistantMessage(event.message)) {
      addUsage(usage, event.message.usage);
      if (
        event.message.stopReason === "error"
        || event.message.stopReason === "aborted"
      ) {
        failure ??= terminalError(
          event.message.stopReason,
          event.message.errorMessage,
        );
      }
      await options.onEvent?.({ type: "usage", usage: publicUsage(usage) });
      return;
    }

    if (
      event.type === "turn_end"
      && event.message.role === "assistant"
      && event.message.stopReason !== "error"
      && event.message.stopReason !== "aborted"
    ) {
      turns += 1;
      await options.onEvent?.({ type: "turn_end", turn: turns });
      if (turns >= maxTurns && hasToolCall(event.message)) {
        failure = budgetError(maxTurns);
        agent.abort();
      }
    }
  });

  const abort = () => agent.abort();
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    await agent.prompt(promptMessages(options.prompt));
  } finally {
    options.signal?.removeEventListener("abort", abort);
    unsubscribe();
  }

  if (failure) throw failure;

  const messages = agent.state.messages.slice(initialMessages.length);
  const answer = [...messages]
    .reverse()
    .find((message): message is AssistantMessage =>
      isAssistantMessage(message)
      && message.stopReason !== "error"
      && message.stopReason !== "aborted"
      && Boolean(assistantText(message)),
    );

  const answerContent = answer ? assistantText(answer) : "";
  return {
    answer: answerContent,
    references: answerSourceReferences(answerContent, [...sourceReferences.values()]),
    messages,
    usage: publicUsage(usage),
    turns,
    toolCalls,
    durationMs: Date.now() - startedAt,
  };
}
