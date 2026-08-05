import {
  DEFAULT_CODEX_REASONING,
  createPlatformModelRuntime,
  modelRuntimeStream,
  resolvePlatformModelConfig,
  type PlatformModelRuntime,
} from "../models";
import { runPlatformAgent } from "../runtime";
import type {
  AgentUsage,
  PlatformAgentEvent,
} from "../types";
import type {
  AgentMessage,
  AgentTool,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AgentHttpError } from "./http-error";
import { createEdgeOneCredentialStore } from "./credential-store";
import { authorizeAgentServiceRequest } from "./service-auth";
import type {
  AgentRequestBody,
  AuthorizedAgentUser,
  CreateEdgeOneAgentHandlerOptions,
  EdgeOneAgentContext,
  EdgeOneStoredMessage,
} from "./types";

const encoder = new TextEncoder();
const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
};

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
  const candidate = value as Record<string, unknown>;
  const message = candidate.message;
  if (typeof message !== "string" || !message.trim()) {
    throw new AgentHttpError(400, "message is required");
  }
  if (message.length > 10_000) {
    throw new AgentHttpError(413, "message exceeds 10000 characters");
  }
  const userId = candidate.userId;
  if (
    typeof userId !== "string"
    || !/^[0-9A-Za-z_-]{1,128}$/.test(userId)
  ) {
    throw new AgentHttpError(400, "userId is required");
  }
  const application = candidate.application;
  if (
    typeof application !== "string"
    || !/^[0-9a-z-]{1,32}$/.test(application)
  ) {
    throw new AgentHttpError(400, "application is required");
  }
  const systemPromptValue = candidate.systemPrompt;
  if (
    systemPromptValue !== undefined
    && (
      typeof systemPromptValue !== "string"
      || !systemPromptValue.trim()
      || systemPromptValue.length > 10_000
    )
  ) {
    throw new AgentHttpError(400, "systemPrompt is invalid");
  }
  let rag: AgentRequestBody["rag"];
  if (candidate.rag !== undefined) {
    if (!candidate.rag || typeof candidate.rag !== "object") {
      throw new AgentHttpError(400, "rag context is invalid");
    }
    const ragValue = candidate.rag as Record<string, unknown>;
    if (
      typeof ragValue.notebookId !== "string"
      || !ragValue.notebookId
      || !Array.isArray(ragValue.sourceIds)
      || ragValue.sourceIds.length === 0
      || ragValue.sourceIds.length > 20
      || !ragValue.sourceIds.every(
        (sourceId) => typeof sourceId === "string" && sourceId.length <= 128,
      )
    ) {
      throw new AgentHttpError(400, "rag context is invalid");
    }
    rag = {
      notebookId: ragValue.notebookId,
      sourceIds: ragValue.sourceIds,
    };
  }
  if (application === "rag" && !rag) {
    throw new AgentHttpError(400, "rag context is required");
  }
  return {
    application,
    userId,
    message: message.trim(),
    ...(typeof systemPromptValue === "string"
      ? { systemPrompt: systemPromptValue.trim() }
      : {}),
    ...(rag ? { rag } : {}),
  };
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
  message: EdgeOneStoredMessage,
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

async function loadHistory(
  context: EdgeOneAgentContext,
  conversationId: string,
  runtime: PlatformModelRuntime,
): Promise<AgentMessage[]> {
  if (!context.store) return [];
  const stored = await context.store.getMessages({
    conversationId,
    limit: 20,
    order: "desc",
  });
  return stored.reverse().flatMap((message) => {
    const converted = historyMessage(message, runtime);
    return converted ? [converted] : [];
  });
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
  body: AgentRequestBody,
): string {
  if (typeof options.systemPrompt === "function") {
    return options.systemPrompt(context, body);
  }
  if (options.systemPrompt) return options.systemPrompt;
  if (body.systemPrompt) return body.systemPrompt;
  return (context.env ?? process.env).JOJO_AGENT_SYSTEM_PROMPT?.trim()
    || "你是 JOJO Platform 的通用助手。准确回答问题；无法确认时明确说明。";
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
    };
  }
  if (event.type === "turn_end") return { turn: event.turn };
  return event.usage;
}

function positiveEnvironmentInteger(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function saveMessage(
  context: EdgeOneAgentContext,
  input: {
    conversationId: string;
    role: "user" | "assistant";
    content: string;
    user: AuthorizedAgentUser;
    usage?: AgentUsage;
  },
): Promise<void> {
  await context.store?.appendMessage({
    conversationId: input.conversationId,
    role: input.role,
    content: input.content,
    userId: input.user.id,
    ...(input.usage ? { metadata: { usage: input.usage } } : {}),
  });
}

export function createEdgeOneAgentHandler(
  options: CreateEdgeOneAgentHandlerOptions,
) {
  return async function onRequest(context: EdgeOneAgentContext): Promise<Response> {
    let body: AgentRequestBody;
    let user: AuthorizedAgentUser;
    let runtime: PlatformModelRuntime;
    try {
      await (options.authorizeService ?? authorizeAgentServiceRequest)(context);
      body = requestBody(context.request.body);
      user = await options.authorize?.(context, body) ?? { id: body.userId };
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
    } catch (error) {
      if (error instanceof AgentHttpError) {
        return jsonResponse(error.status, { error: error.message });
      }
      return jsonResponse(503, {
        error: error instanceof Error ? error.message : "Agent configuration failed",
      });
    }

    const conversationId = context.conversation_id || crypto.randomUUID();
    const storageConversationId = `${user.id}:${conversationId}`;
    let history: AgentMessage[];
    let tools: AgentTool[];
    try {
      history = await loadHistory(context, storageConversationId, runtime);
      tools = await options.tools?.(context, user, body) ?? [];
      await saveMessage(context, {
        conversationId: storageConversationId,
        role: "user",
        content: body.message,
        user,
      });
    } catch {
      return jsonResponse(503, { error: "Agent conversation store unavailable" });
    }
    const environment = context.env ?? process.env;

    context.tracer?.setAttributes?.({
      "agent.provider": runtime.config.provider,
      "agent.model": runtime.config.model,
      "agent.conversation_id": conversationId,
    });

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          controller.enqueue(sseFrame("status", {
            provider: runtime.config.provider,
            model: runtime.config.model,
            conversationId,
          }));
          const result = await runPlatformAgent({
            systemPrompt: systemPrompt(options, context, body),
            prompt: body.message,
            history,
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
          await saveMessage(context, {
            conversationId: storageConversationId,
            role: "assistant",
            content: result.answer,
            user,
            usage: result.usage,
          });
          controller.enqueue(sseFrame("done", {
            conversationId,
            usage: result.usage,
          }));
        } catch (error) {
          controller.enqueue(sseFrame("error", {
            message: error instanceof Error ? error.message : "Agent run failed",
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

export function createEdgeOneAgentHealthHandler(
  options: Pick<CreateEdgeOneAgentHandlerOptions, "authorizeService"> = {},
) {
  return async function onRequest(context: EdgeOneAgentContext): Promise<Response> {
    try {
      await (options.authorizeService ?? authorizeAgentServiceRequest)(
        context,
        { method: "GET" },
      );
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
        error: error instanceof Error ? error.message : "Agent configuration failed",
      });
    }
  };
}
