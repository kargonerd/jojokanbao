import type {
  AgentMessage,
  AgentTool,
} from "@earendil-works/pi-agent-core";
import type {
  AgentEnvironment,
  PlatformModelRuntime,
} from "../models";

export interface EdgeOneStoredMessage {
  messageId?: string;
  role: "user" | "assistant" | "system" | "tool";
  content: unknown;
  createdAt?: number;
  updatedAt?: number;
  metadata?: Record<string, unknown>;
}

export interface EdgeOneConversationMeta {
  conversationId: string;
  createdAt: number;
  lastMessageAt: number;
  messageCount: number;
  metadata?: Record<string, unknown>;
}

export interface EdgeOneConversationList {
  items: EdgeOneConversationMeta[];
  nextCursor?: string;
  previousCursor?: string;
}

export interface EdgeOneConversationStore {
  getMessages(input: {
    conversationId: string;
    limit?: number;
    order?: "asc" | "desc";
  }): Promise<EdgeOneStoredMessage[]>;
  appendMessage(input: {
    conversationId: string;
    role: "user" | "assistant" | "system" | "tool";
    content: unknown;
    userId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<string>;
  updateMessage?(input: {
    conversationId: string;
    messageId: string;
    content?: unknown;
    metadata?: Record<string, unknown>;
  }): Promise<EdgeOneStoredMessage>;
  getConversation?(input: {
    conversationId: string;
  }): Promise<EdgeOneConversationMeta>;
  listConversations?(input: {
    limit?: number;
    order?: "asc" | "desc";
    after?: string;
    before?: string;
    userId?: string;
  }): Promise<EdgeOneConversationList>;
  updateConversation?(input: {
    conversationId: string;
    metadata: Record<string, unknown>;
  }): Promise<EdgeOneConversationMeta>;
  deleteConversation?(input: {
    conversationId: string;
  }): Promise<void>;
}

export interface EdgeOneAgentRequest {
  body?: unknown;
  headers?: Headers | Readonly<Record<string, string | undefined>>;
  method?: string;
  signal?: AbortSignal;
}

export type EdgeOneTraceAttributes = Record<string, string | number | boolean>;

export interface EdgeOneTraceSpan {
  setAttributes?(attributes: EdgeOneTraceAttributes): void;
  end?(): void;
}

export interface EdgeOneTracer {
  span?<T>(
    name: string,
    callback: (span: EdgeOneTraceSpan) => Promise<T>,
    attributes?: EdgeOneTraceAttributes,
  ): Promise<T>;
  startSpan?(name: string, attributes?: EdgeOneTraceAttributes): EdgeOneTraceSpan;
  setAttributes?(attributes: EdgeOneTraceAttributes): void;
}

export interface EdgeOneAgentContext {
  conversation_id?: string;
  env?: AgentEnvironment;
  request: EdgeOneAgentRequest;
  store?: EdgeOneConversationStore;
  tracer?: EdgeOneTracer;
}

export interface AuthorizedAgentUser {
  id: string;
}

export interface CreateEdgeOneAgentHandlerOptions {
  systemPrompt?: string | ((context: EdgeOneAgentContext) => string);
  tools?: (
    context: EdgeOneAgentContext,
    user: AuthorizedAgentUser,
  ) => AgentTool[] | Promise<AgentTool[]>;
  authorize?: (
    context: EdgeOneAgentContext,
  ) => AuthorizedAgentUser | Promise<AuthorizedAgentUser>;
  createModelRuntime?: (
    context: EdgeOneAgentContext,
  ) => PlatformModelRuntime | Promise<PlatformModelRuntime>;
}

export interface AgentRequestBody {
  message: string;
  historyMode?: "store" | "client";
  history?: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
  scope?: {
    mode?: "all" | "selected";
    datasetIds?: string[];
    itemIds?: string[];
    manifestObjects?: string[];
  };
}

export type StoredAgentHistory = AgentMessage[];
