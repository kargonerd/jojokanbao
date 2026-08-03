import type {
  AgentEnvironment,
  AgentMessage,
  AgentTool,
  PlatformModelRuntime,
} from "@jojo/agent-runtime";

export interface EdgeOneStoredMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: unknown;
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
}

export interface EdgeOneAgentRequest {
  body?: unknown;
  headers?: Headers | Readonly<Record<string, string | undefined>>;
  method?: string;
  signal?: AbortSignal;
}

export interface EdgeOneAgentContext {
  conversation_id?: string;
  env?: AgentEnvironment;
  request: EdgeOneAgentRequest;
  store?: EdgeOneConversationStore;
  tracer?: {
    setAttributes?(attributes: Record<string, unknown>): void;
  };
}

export interface AuthorizedAgentUser {
  id: string;
}

export interface CreateEdgeOneAgentHandlerOptions {
  authorizeService?: (
    context: EdgeOneAgentContext,
  ) => void | Promise<void>;
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
}

export type StoredAgentHistory = AgentMessage[];
