import type {
  AgentLoopConfig,
  AgentLoopTurnUpdate,
  AgentMessage,
  AgentTool,
  BeforeToolCallContext,
  BeforeToolCallResult,
  PrepareNextTurnContext,
  StreamFn,
  ToolExecutionMode,
} from "@earendil-works/pi-agent-core";
import type { Api, Message, Model, ThinkingLevel } from "@earendil-works/pi-ai";

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens?: number;
  reasoningTokens?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export type PlatformAgentStatus = "placeholder" | "available";

/**
 * Product-owned Agent configuration.
 *
 * RAG and Olds expose this small boundary now so deployment code can select a
 * product without coupling its prompts and tools to a hosting platform.
 */
export interface PlatformAgentDefinition {
  id: string;
  status: PlatformAgentStatus;
  systemPrompt: string;
  createTools(): AgentTool[];
}

export type PlatformAgentEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; callId: string; name: string; args: unknown }
  | { type: "tool_end"; callId: string; name: string; isError: boolean }
  | { type: "turn_end"; turn: number }
  | { type: "usage"; usage: AgentUsage };

export interface RunPlatformAgentOptions {
  /** Product-owned instructions. RAG and Olds provide different prompts. */
  systemPrompt: string;
  /** One string becomes a user message; advanced callers can provide messages directly. */
  prompt: string | AgentMessage[];
  /** Existing conversation messages visible to the model. */
  history?: AgentMessage[];
  /** Product-owned capabilities, such as document search or news lookup. */
  tools?: AgentTool[];
  /** Model selection remains an application/deployment concern. */
  model: Model<Api>;
  /**
   * Usually `(model, context, options) => models.streamSimple(...)`.
   * A credential-aware Models instance can resolve auth itself. Direct provider streams
   * can instead use `apiKey` or `getApiKey` below.
   */
  stream: StreamFn;
  /** Static credential forwarded to the provider stream. Never include it in events or logs. */
  apiKey?: string;
  /** Resolve short-lived credentials immediately before every model request. */
  getApiKey?: AgentLoopConfig["getApiKey"];
  signal?: AbortSignal;
  reasoning?: ThinkingLevel;
  toolExecution?: ToolExecutionMode;
  maxTurns?: number;
  maxToolCalls?: number;
  convertToLlm?: AgentLoopConfig["convertToLlm"];
  beforeToolCall?: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<BeforeToolCallResult | undefined>;
  /** Modify model/context before Pi starts another provider turn. */
  prepareNextTurn?: (
    context: PrepareNextTurnContext,
    signal?: AbortSignal,
  ) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;
  onEvent?: (event: PlatformAgentEvent) => void | Promise<void>;
}

export interface PlatformAgentResult {
  answer: string;
  /** Messages produced by this run, including the supplied prompt but excluding prior history. */
  messages: AgentMessage[];
  usage: AgentUsage;
  turns: number;
  /** Tool calls admitted by the runtime budget; blocked excess calls are not counted. */
  toolCalls: number;
  durationMs: number;
}

export const defaultMessageConverter = (messages: AgentMessage[]): Message[] =>
  messages as Message[];
