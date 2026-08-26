import type { AgentEnvironment } from "../models";
import type { AgentSourceReference } from "../types";
import { AgentHttpError, authorizeSupabaseUser } from "./auth";
import type {
  AuthorizedAgentUser,
  EdgeOneConversationMeta,
  EdgeOneConversationStore,
  EdgeOneStoredMessage,
} from "./types";

const CONVERSATION_PREFIX = "/gateway/conversations";
const CONVERSATION_ID = /^[0-9A-Za-z._-]{6,128}$/;

export interface ConversationAdminContext {
  agent?: { store?: EdgeOneConversationStore };
  env?: AgentEnvironment;
  request: Request;
}

export interface CreateConversationAdminHandlerOptions {
  authorize?: (
    context: ConversationAdminContext,
  ) => AuthorizedAgentUser | Promise<AuthorizedAgentUser>;
}

function jsonResponse(status: number, body: unknown): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function externalConversationId(
  storedId: string,
  userId: string,
): string | undefined {
  const prefix = `${userId}:`;
  return storedId.startsWith(prefix) ? storedId.slice(prefix.length) : undefined;
}

function storedConversationId(userId: string, externalId: string): string {
  return `${userId}:${externalId}`;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length ? strings : undefined;
}

function conversationScope(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const scope = value as Record<string, unknown>;
  const datasetIds = stringList(scope.datasetIds);
  const itemIds = stringList(scope.itemIds);
  const manifestObjects = stringList(scope.manifestObjects);
  const mode = scope.mode === "all" || scope.mode === "selected"
    ? scope.mode
    : undefined;
  return mode || datasetIds || itemIds || manifestObjects
    ? { mode, datasetIds, itemIds, manifestObjects }
    : undefined;
}

function reference(value: unknown): AgentSourceReference | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (typeof input.targetId !== "string" || !input.targetId) return undefined;
  return {
    targetId: input.targetId,
    ...(typeof input.citationId === "string" ? { citationId: input.citationId } : {}),
    ...(typeof input.datasetId === "string" ? { datasetId: input.datasetId } : {}),
    ...(typeof input.itemId === "string" ? { itemId: input.itemId } : {}),
    ...(typeof input.datasetTitle === "string" ? { datasetTitle: input.datasetTitle } : {}),
    ...(typeof input.itemTitle === "string" ? { itemTitle: input.itemTitle } : {}),
    ...(typeof input.anchorId === "string" ? { anchorId: input.anchorId } : {}),
    ...(typeof input.title === "string" ? { title: input.title } : {}),
    ...(typeof input.excerpt === "string" ? { excerpt: input.excerpt } : {}),
    ...(typeof input.fragmentObject === "string"
      ? { fragmentObject: input.fragmentObject }
      : {}),
  };
}

function message(value: EdgeOneStoredMessage) {
  if (
    (value.role !== "user" && value.role !== "assistant")
    || typeof value.content !== "string"
  ) return undefined;
  const references = Array.isArray(value.metadata?.references)
    ? value.metadata.references.flatMap((candidate) => {
      const parsed = reference(candidate);
      return parsed ? [parsed] : [];
    })
    : [];
  return {
    id: value.messageId,
    role: value.role,
    content: value.content,
    createdAt: value.createdAt,
    ...(references.length ? { references } : {}),
  };
}

function summary(meta: EdgeOneConversationMeta, userId: string) {
  const id = externalConversationId(meta.conversationId, userId);
  if (!id || meta.metadata?.kind !== "rag-chat") return undefined;
  const title = typeof meta.metadata.title === "string"
    ? meta.metadata.title
    : "未命名对话";
  const scope = conversationScope(meta.metadata.scope);
  return {
    id,
    title,
    createdAt: meta.createdAt,
    lastMessageAt: meta.lastMessageAt,
    messageCount: meta.messageCount,
    ...(scope ? { scope } : {}),
  };
}

async function defaultAuthorize(
  context: ConversationAdminContext,
): Promise<AuthorizedAgentUser> {
  return authorizeSupabaseUser({
    env: context.env,
    request: {
      headers: context.request.headers,
      method: context.request.method,
      signal: context.request.signal,
    },
  });
}

function parsedConversationId(pathname: string): string | undefined {
  if (!pathname.startsWith(`${CONVERSATION_PREFIX}/`)) return undefined;
  try {
    const id = decodeURIComponent(pathname.slice(CONVERSATION_PREFIX.length + 1));
    return CONVERSATION_ID.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

export function createConversationAdminHandler(
  options: CreateConversationAdminHandlerOptions = {},
) {
  return async function onRequest(
    context: ConversationAdminContext,
  ): Promise<Response> {
    let user: AuthorizedAgentUser;
    try {
      user = await (options.authorize ?? defaultAuthorize)(context);
    } catch (error) {
      if (error instanceof AgentHttpError) {
        return jsonResponse(error.status, { error: error.message });
      }
      return jsonResponse(503, { error: "Authentication service unavailable" });
    }

    const store = context.agent?.store;
    if (!store) return jsonResponse(503, { error: "Conversation storage is unavailable" });
    const url = new URL(context.request.url);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (pathname === CONVERSATION_PREFIX && context.request.method === "GET") {
        if (!store.listConversations) {
          return jsonResponse(503, { error: "Conversation listing is unavailable" });
        }
        const requestedLimit = Number(url.searchParams.get("limit") ?? "30");
        const limit = Number.isFinite(requestedLimit)
          ? Math.max(1, Math.min(100, Math.floor(requestedLimit)))
          : 30;
        const result = await store.listConversations({
          userId: user.id,
          limit,
          order: "desc",
          ...(url.searchParams.get("after")
            ? { after: url.searchParams.get("after")! }
            : {}),
        });
        return jsonResponse(200, {
          conversations: result.items.flatMap((item) => {
            const parsed = summary(item, user.id);
            return parsed ? [parsed] : [];
          }),
          nextCursor: result.nextCursor,
        });
      }

      const conversationId = parsedConversationId(pathname);
      if (!conversationId) return jsonResponse(404, { error: "Not found" });
      const storageId = storedConversationId(user.id, conversationId);

      if (context.request.method === "GET") {
        const [storedMessages, meta] = await Promise.all([
          store.getMessages({
            conversationId: storageId,
            limit: 100,
            order: "asc",
          }),
          store.getConversation?.({ conversationId: storageId }),
        ]);
        const messages = storedMessages.flatMap((item) => {
          const parsed = message(item);
          return parsed ? [parsed] : [];
        });
        if (!messages.length && !meta) {
          return jsonResponse(404, { error: "Conversation not found" });
        }
        return jsonResponse(200, {
          conversation: {
            id: conversationId,
            title: typeof meta?.metadata?.title === "string"
              ? meta.metadata.title
              : messages.find((item) => item.role === "user")?.content.slice(0, 80)
                || "未命名对话",
            createdAt: meta?.createdAt,
            lastMessageAt: meta?.lastMessageAt,
            messageCount: meta?.messageCount ?? messages.length,
            ...(conversationScope(meta?.metadata?.scope)
              ? { scope: conversationScope(meta?.metadata?.scope) }
              : {}),
          },
          messages,
        });
      }

      if (context.request.method === "DELETE") {
        if (!store.deleteConversation) {
          return jsonResponse(503, { error: "Conversation deletion is unavailable" });
        }
        await store.deleteConversation({ conversationId: storageId });
        return new Response(null, {
          status: 204,
          headers: { "Cache-Control": "no-store" },
        });
      }

      return jsonResponse(405, { error: "Method not allowed" });
    } catch {
      return jsonResponse(503, { error: "Conversation storage is unavailable" });
    }
  };
}
