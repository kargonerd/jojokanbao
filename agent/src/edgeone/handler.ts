import {
  DEFAULT_CODEX_REASONING,
  createPlatformModelRuntime,
  modelRuntimeStream,
  resolvePlatformModelConfig,
  type PlatformModelRuntime,
} from "../models";
import { runPlatformAgent } from "../runtime";
import type { PlatformAgentEvent } from "../types";
import type {
  AgentMessage,
  AgentTool,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AgentHttpError, authorizeSupabaseUser } from "./auth";
import { createEdgeOneCredentialStore } from "./credential-store";
import type {
  AgentRequestBody,
  AuthorizedAgentUser,
  CreateEdgeOneAgentHandlerOptions,
  EdgeOneAgentContext,
  EdgeOneTraceSpan,
  EdgeOneTracer,
} from "./types";

const encoder = new TextEncoder();
const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
};
type SupportedImageMediaType = NonNullable<AgentRequestBody["images"]>[number]["mimeType"];
const IMAGE_MEDIA_TYPES = new Set<SupportedImageMediaType>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const);
const MAX_IMAGE_COUNT = 4;
const MAX_IMAGE_BYTES = 1_500_000;
const MAX_TOTAL_IMAGE_BYTES = 4_000_000;

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status });
}

function sseFrame(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function requestBody(value: unknown): AgentRequestBody {
  if (!value || typeof value !== "object" || !("message" in value)) {
    throw new AgentHttpError(400, "message is required");
  }
  const message = (value as { message?: unknown }).message;
  if (typeof message !== "string" || !message.trim()) {
    throw new AgentHttpError(400, "message is required");
  }
  if (message.length > 10_000) {
    throw new AgentHttpError(413, "message exceeds 10000 characters");
  }
  const rawImages = (value as { images?: unknown }).images;
  if (rawImages !== undefined && !Array.isArray(rawImages)) {
    throw new AgentHttpError(400, "images must be an array");
  }
  if (Array.isArray(rawImages) && rawImages.length > MAX_IMAGE_COUNT) {
    throw new AgentHttpError(413, `images exceed ${MAX_IMAGE_COUNT} items`);
  }
  let totalImageBytes = 0;
  const images = (rawImages ?? []).map((candidate: unknown) => {
    if (!candidate || typeof candidate !== "object") {
      throw new AgentHttpError(400, "images contains an invalid image");
    }
    const input = candidate as Record<string, unknown>;
    const mimeType = input.mimeType;
    const data = typeof input.data === "string" ? input.data.trim() : "";
    if (
      typeof mimeType !== "string"
      || !IMAGE_MEDIA_TYPES.has(mimeType as SupportedImageMediaType)
      || !data
      || data.length % 4 !== 0
      || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)
    ) {
      throw new AgentHttpError(400, "images contains an invalid image");
    }
    const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
    const imageBytes = (data.length / 4) * 3 - padding;
    totalImageBytes += imageBytes;
    if (imageBytes > MAX_IMAGE_BYTES || totalImageBytes > MAX_TOTAL_IMAGE_BYTES) {
      throw new AgentHttpError(413, "images are too large");
    }
    return {
      data,
      mimeType: mimeType as NonNullable<AgentRequestBody["images"]>[number]["mimeType"],
    };
  });
  const rawScope = (value as { scope?: unknown }).scope;
  const scope = rawScope && typeof rawScope === "object"
    ? rawScope as Record<string, unknown>
    : undefined;
  const stringList = (candidate: unknown): string[] | undefined => {
    if (!Array.isArray(candidate)) return undefined;
    const strings = candidate
      .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      .map((item) => item.trim())
      .slice(0, 100);
    return strings.length ? strings : undefined;
  };
  const datasetIds = stringList(scope?.datasetIds);
  const itemIds = stringList(scope?.itemIds);
  const manifestObjects = stringList(scope?.manifestObjects);
  const mode = scope?.mode === "all" || scope?.mode === "selected"
    ? scope.mode
    : undefined;
  const rawFocus = (value as { focus?: unknown }).focus;
  let focus: AgentRequestBody["focus"];
  if (rawFocus !== undefined) {
    if (!rawFocus || typeof rawFocus !== "object") {
      throw new AgentHttpError(400, "focus must be an object");
    }
    const input = rawFocus as Record<string, unknown>;
    const chapterId = typeof input.chapterId === "string" ? input.chapterId.trim() : "";
    const quote = typeof input.quote === "string" ? input.quote : "";
    if (!chapterId || chapterId.length > 500 || !quote.trim() || quote.length > 4_000) {
      throw new AgentHttpError(400, "focus contains an invalid chapter or quote");
    }
    const optionalText = (
      name: string,
      maxCharacters: number,
      preserveWhitespace = false,
    ): string | undefined => {
      const candidate = input[name];
      if (candidate === undefined) return undefined;
      if (typeof candidate !== "string" || candidate.length > maxCharacters) {
        throw new AgentHttpError(400, `focus.${name} is invalid`);
      }
      if (preserveWhitespace) return candidate || undefined;
      const normalized = candidate.trim();
      return normalized || undefined;
    };
    const chapterTitle = optionalText("chapterTitle", 500);
    const prefix = optionalText("prefix", 1_200, true);
    const suffix = optionalText("suffix", 1_200, true);
    focus = {
      chapterId,
      quote,
      ...(chapterTitle ? { chapterTitle } : {}),
      ...(prefix ? { prefix } : {}),
      ...(suffix ? { suffix } : {}),
    };
    if (itemIds?.length !== 1 || manifestObjects?.length !== 1) {
      throw new AgentHttpError(400, "focus requires one selected book item");
    }
  }
  const rawHistory = (value as { history?: unknown }).history;
  if (rawHistory !== undefined && !Array.isArray(rawHistory)) {
    throw new AgentHttpError(400, "history must be an array");
  }
  let historyCharacters = 0;
  const history = (rawHistory ?? []).slice(-20).map((candidate: unknown) => {
    if (!candidate || typeof candidate !== "object") {
      throw new AgentHttpError(400, "history contains an invalid message");
    }
    const rawRole = (candidate as { role?: unknown }).role;
    const content = (candidate as { content?: unknown }).content;
    if ((rawRole !== "user" && rawRole !== "assistant") || typeof content !== "string") {
      throw new AgentHttpError(400, "history contains an invalid message");
    }
    const role: "user" | "assistant" = rawRole;
    const trimmed = content.trim();
    const maxCharacters = role === "user" ? 10_000 : 20_000;
    if (!trimmed || trimmed.length > maxCharacters) {
      throw new AgentHttpError(413, "history message is too large");
    }
    historyCharacters += trimmed.length;
    return { role, content: trimmed };
  });
  if (historyCharacters > 100_000) {
    throw new AgentHttpError(413, "history exceeds 100000 characters");
  }
  return {
    message: message.trim(),
    ...(images.length ? { images } : {}),
    ...(history.length ? { history } : {}),
    ...(mode || datasetIds || itemIds || manifestObjects
      ? { scope: {
        ...(mode ? { mode } : {}),
        ...(datasetIds ? { datasetIds } : {}),
        ...(itemIds ? { itemIds } : {}),
        ...(manifestObjects ? { manifestObjects } : {}),
      } }
      : {}),
    ...(focus ? { focus } : {}),
  };
}

function requestPrompt(body: AgentRequestBody): string | AgentMessage[] {
  if (!body.images?.length) return body.message;
  return [{
    role: "user",
    content: [
      { type: "text", text: body.message },
      ...body.images.map((image) => ({
        type: "image" as const,
        data: image.data,
        mimeType: image.mimeType,
      })),
    ],
    timestamp: Date.now(),
  }];
}

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function historyMessage(
  message: NonNullable<AgentRequestBody["history"]>[number],
  runtime: PlatformModelRuntime,
): AgentMessage | undefined {
  if (typeof message.content !== "string") return undefined;
  if (message.role === "user") {
    return {
      role: "user",
      content: message.content.slice(0, 10_000),
      timestamp: Date.now(),
    };
  }
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: [{ type: "text", text: message.content.slice(0, 20_000) }],
      api: runtime.model.api,
      provider: runtime.model.provider,
      model: runtime.model.id,
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    };
  }
  return undefined;
}

async function defaultModelRuntime(
  context: EdgeOneAgentContext,
): Promise<PlatformModelRuntime> {
  const environment = context.env ?? process.env;
  const config = resolvePlatformModelConfig(environment);
  const credentials = createEdgeOneCredentialStore(environment, context.store);
  return createPlatformModelRuntime({
    config,
    environment,
    credentials,
  });
}

function systemPrompt(
  options: CreateEdgeOneAgentHandlerOptions,
  context: EdgeOneAgentContext,
): string {
  if (typeof options.systemPrompt === "function") return options.systemPrompt(context);
  if (options.systemPrompt) return options.systemPrompt;
  return (context.env ?? process.env).JOJO_AGENT_SYSTEM_PROMPT?.trim()
    || "你是 JOJO 看报的通用助手。准确回答问题；无法确认时明确说明。";
}

function eventPayload(event: PlatformAgentEvent): unknown {
  if (event.type === "text_delta") return { delta: event.delta };
  if (event.type === "tool_start") {
    return { callId: event.callId, name: event.name, args: event.args };
  }
  if (event.type === "tool_end") {
    return {
      callId: event.callId,
      name: event.name,
      isError: event.isError,
      ...(event.references?.length ? { references: event.references } : {}),
    };
  }
  if (event.type === "turn_end") return { turn: event.turn };
  return event.usage;
}

function clientHistory(
  messages: NonNullable<AgentRequestBody["history"]>,
  runtime: PlatformModelRuntime,
): AgentMessage[] {
  return messages.flatMap((message) => {
    const converted = historyMessage(message, runtime);
    return converted ? [converted] : [];
  });
}

function traceJson(value: unknown, maxChars = 4_000): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = String(value);
  }
  return serialized.length <= maxChars
    ? serialized
    : `${serialized.slice(0, maxChars)}…`;
}

function traceResultSummary(value: unknown): string {
  if (!value || typeof value !== "object") return traceJson(value, 1_000);
  const details = "details" in value && value.details && typeof value.details === "object"
    ? value.details as Record<string, unknown>
    : value as Record<string, unknown>;
  const summary = Object.fromEntries(
    [
      "strategy",
      "available",
      "needsSelection",
      "total",
      "searchedItemCount",
      "loadedSearchBytes",
      "chapterCount",
      "scannedChapterCount",
      "downloadedBytes",
      "truncated",
    ].flatMap((key) => (
      typeof details[key] === "string"
      || typeof details[key] === "number"
      || typeof details[key] === "boolean"
        ? [[key, details[key]]]
        : []
    )),
  );
  return traceJson(summary, 1_000);
}

async function traced<T>(
  tracer: EdgeOneTracer | undefined,
  name: string,
  callback: (span: EdgeOneTraceSpan) => Promise<T>,
  attributes?: Record<string, string | number | boolean>,
): Promise<T> {
  if (tracer?.span) return tracer.span(name, callback, attributes);
  return callback({});
}

function tracedTools(tools: AgentTool[], tracer: EdgeOneTracer | undefined): AgentTool[] {
  if (!tracer?.span) return tools;
  return tools.map((tool) => {
    const execute = tool.execute;
    return {
      ...tool,
      execute: async (...args: Parameters<typeof execute>) => traced(
        tracer,
        `jojo.tool.${tool.name}`,
        async (span) => {
          const startedAt = Date.now();
          try {
            const output = await execute(...args);
            span.setAttributes?.({
              "tool.status": "ok",
              "tool.duration_ms": Date.now() - startedAt,
              "tool.result_summary": traceResultSummary(output),
            });
            return output;
          } catch (error) {
            span.setAttributes?.({
              "tool.status": "error",
              "tool.duration_ms": Date.now() - startedAt,
              "error.type": error instanceof Error ? error.name : "Error",
              "error.message": error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        },
        {
          "openinference.span.kind": "TOOL",
          "tool.name": tool.name,
          "tool.arguments": traceJson(args[1]),
        },
      ),
    } as AgentTool;
  });
}

function positiveEnvironmentInteger(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function createEdgeOneAgentHandler(
  options: CreateEdgeOneAgentHandlerOptions,
) {
  return async function onRequest(context: EdgeOneAgentContext): Promise<Response> {
    let body: AgentRequestBody;
    let user: AuthorizedAgentUser;
    let runtime: PlatformModelRuntime;
    try {
      body = requestBody(context.request.body);
      user = await (options.authorize ?? authorizeSupabaseUser)(context);
      runtime = await (
        options.createModelRuntime?.(context)
        ?? defaultModelRuntime(context)
      );
      if (!runtime.configured) {
        throw new AgentHttpError(
          503,
          `${runtime.config.provider}/${runtime.config.model} is not configured`,
        );
      }
      if (body.images?.length && !runtime.model.input.includes("image")) {
        throw new AgentHttpError(503, "current model does not support image input");
      }
    } catch (error) {
      if (error instanceof AgentHttpError) {
        return jsonResponse(error.status, { error: error.message });
      }
      return jsonResponse(503, {
        error: error instanceof Error ? error.message : "问答服务配置失败",
      });
    }

    const conversationId = context.conversation_id || crypto.randomUUID();
    const history = clientHistory(body.history ?? [], runtime);
    let tools: AgentTool[];
    try {
      tools = tracedTools(await options.tools?.(context, user, body) ?? [], context.tracer);
    } catch {
      return jsonResponse(503, { error: "馆藏问答工具暂时不可用" });
    }
    const environment = context.env ?? process.env;

    context.tracer?.setAttributes?.({
      "agent.provider": runtime.config.provider,
      "agent.model": runtime.config.model,
      "agent.conversation_id": conversationId,
      "agent.has_focus_context": Boolean(body.focus),
      "agent.image_count": body.images?.length ?? 0,
    });

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          controller.enqueue(sseFrame("status", {
            provider: runtime.config.provider,
            model: runtime.config.model,
            conversationId,
          }));
          const result = await traced(
            context.tracer,
            `jojo.${options.agentId || "rag"}_agent`,
            async (span) => {
              const output = await runPlatformAgent({
                systemPrompt: systemPrompt(options, context),
                prompt: requestPrompt(body),
                history,
                sessionId: conversationId,
                tools,
                model: runtime.model,
                stream: modelRuntimeStream(runtime),
                signal: context.request.signal,
                reasoning: DEFAULT_CODEX_REASONING,
                maxTurns: positiveEnvironmentInteger(
                  environment.JOJO_AGENT_MAX_TURNS,
                  8,
                ),
                maxToolCalls: positiveEnvironmentInteger(
                  environment.JOJO_AGENT_MAX_TOOL_CALLS,
                  20,
                ),
                onEvent(event) {
                  controller.enqueue(sseFrame(event.type, eventPayload(event)));
                },
              });
              span.setAttributes?.({
                "agent.status": "ok",
                "agent.turns": output.turns,
                "agent.tool_calls": output.toolCalls,
                "agent.duration_ms": output.durationMs,
                "llm.token_count.total": output.usage.totalTokens,
                "llm.token_count.prompt": output.usage.inputTokens,
                "llm.token_count.completion": output.usage.outputTokens,
              });
              return output;
            },
            {
              "openinference.span.kind": "AGENT",
              "agent.name": `jojo-${options.agentId || "rag"}`,
              "agent.conversation_id": conversationId,
              "agent.scope_mode": body.scope?.mode ?? "all",
              "agent.has_focus_context": Boolean(body.focus),
              "agent.history_messages": history.length,
              "agent.image_count": body.images?.length ?? 0,
            },
          );
          controller.enqueue(sseFrame("done", {
            conversationId,
            usage: result.usage,
          }));
        } catch (error) {
          controller.enqueue(sseFrame("error", {
            message: error instanceof Error ? error.message : "回答生成失败",
            name: error instanceof Error ? error.name : "Error",
          }));
          controller.enqueue(sseFrame("done", {
            conversationId,
            stopped: context.request.signal?.aborted ?? false,
          }));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, { status: 200, headers: SSE_HEADERS });
  };
}

export function createEdgeOneAgentHealthHandler() {
  return async function onRequest(context: EdgeOneAgentContext): Promise<Response> {
    try {
      const runtime = await defaultModelRuntime(context);
      return jsonResponse(200, {
        ok: true,
        provider: runtime.config.provider,
        model: runtime.config.model,
        configured: runtime.configured,
        supportedProviders: ["openai-codex"],
      });
    } catch (error) {
      if (error instanceof AgentHttpError) {
        return jsonResponse(error.status, { error: error.message });
      }
      return jsonResponse(200, {
        ok: false,
        configured: false,
        error: error instanceof Error ? error.message : "问答服务配置失败",
      });
    }
  };
}
