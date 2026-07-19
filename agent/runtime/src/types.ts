import type {
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  BeforeToolCallContext,
  BeforeToolCallResult,
  ShouldStopAfterTurnContext,
  StreamFn,
  ToolExecutionMode,
} from "@earendil-works/pi-agent-core";
import type { Api, Message, Model, ThinkingLevel } from "@earendil-works/pi-ai";

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export type PlatformAgentEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; callId: string; name: string; args: unknown }
  | { type: "tool_end"; callId: string; name: string; isError: boolean }
  | { type: "turn_end"; turn: number }
  | { type: "usage"; usage: AgentUsage };

export interface RunPlatformAgentOptions {
  /** Product-owned instructions. RAG and Jiuwen provide different prompts. */
  systemPrompt: string;
  /** One string becomes a user message; advanced callers can provide messages directly. */
  prompt: string | AgentMessage[];
  /** Existing conversation messages visible to the model. */
  history?: AgentMessage[];
  /** Product-owned capabilities, such as document search or news lookup. */
  tools?: AgentTool[];
  /** Model selection remains an application/deployment concern. */
  model: Model<Api>;
  /** Usually `(model, context, options) => models.streamSimple(...)`. */
  stream: StreamFn;
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
  shouldStopAfterTurn?: (
    context: ShouldStopAfterTurnContext,
  ) => boolean | Promise<boolean>;
  onEvent?: (event: PlatformAgentEvent) => void | Promise<void>;
}

export interface PlatformAgentResult {
  answer: string;
  messages: AgentMessage[];
  usage: AgentUsage;
  turns: number;
  toolCalls: number;
  durationMs: number;
}

export const defaultMessageConverter = (messages: AgentMessage[]): Message[] =>
  messages as Message[];
