import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
  AgentEnvironment,
  PlatformModelRuntime,
} from "../models";
import type { RagFocusContext } from "../rag-tools";

export interface EdgeOneStoredMessage {
  messageId?: string;
  content: unknown;
}

export interface EdgeOneMessageStore {
  getMessages(input: {
    conversationId: string;
    limit?: number;
    order?: "asc" | "desc";
  }): Promise<EdgeOneStoredMessage[]>;
  appendMessage(input: {
    conversationId: string;
    role: "system";
    content: unknown;
    metadata?: Record<string, unknown>;
  }): Promise<string>;
  updateMessage?(input: {
    conversationId: string;
    messageId: string;
    content?: unknown;
    metadata?: Record<string, unknown>;
  }): Promise<EdgeOneStoredMessage>;
}

export interface EdgeOneAgentRequest {
  body?: unknown;
  headers?: Headers | Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
}

export type EdgeOneTraceAttributes = Record<string, string | number | boolean>;

export interface EdgeOneTraceSpan {
  setAttributes?(attributes: EdgeOneTraceAttributes): void;
}

export interface EdgeOneTracer {
  span?<T>(
    name: string,
    callback: (span: EdgeOneTraceSpan) => Promise<T>,
    attributes?: EdgeOneTraceAttributes,
  ): Promise<T>;
  setAttributes?(attributes: EdgeOneTraceAttributes): void;
}

export interface EdgeOneAgentContext {
  conversation_id?: string;
  env?: AgentEnvironment;
  request: EdgeOneAgentRequest;
  store?: EdgeOneMessageStore;
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
    body: AgentRequestBody,
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
  focus?: RagFocusContext;
}
