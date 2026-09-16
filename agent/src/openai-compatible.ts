import {
  envApiKeyAuth,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import {
  stream as streamOpenAICompletions,
  streamSimple as streamOpenAICompletionsSimple,
} from "@earendil-works/pi-ai/api/openai-completions";

/**
 * Third agent provider: any OpenAI-compatible chat completions endpoint
 * configured through `JOJO_AGENT_BASE_URL`, `JOJO_AGENT_API_KEY` and
 * `JOJO_AGENT_MODEL`. Unlike the OAuth providers there is no catalog to
 * discover, so the configured model id becomes a single-entry catalog.
 */
export const OPENAI_COMPATIBLE_PROVIDER_ID = "openai-compatible";
export const OPENAI_COMPATIBLE_API_KEY_ENV_VAR = "JOJO_AGENT_API_KEY";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

export interface OpenAICompatibleProviderOptions {
  baseUrl: string;
  model: string;
  contextWindow?: number;
  maxTokens?: number;
}

export function openAICompatibleProvider(
  options: OpenAICompatibleProviderOptions,
): Provider<"openai-completions"> {
  const model: Model<"openai-completions"> = {
    id: options.model,
    name: options.model,
    api: "openai-completions",
    provider: OPENAI_COMPATIBLE_PROVIDER_ID,
    baseUrl: options.baseUrl,
    reasoning: false,
    input: ["text"],
    // The endpoint does not publish pricing; usage is still reported in
    // tokens, only the cost estimate stays zero.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: options.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
  return {
    id: OPENAI_COMPATIBLE_PROVIDER_ID,
    name: "OpenAI-compatible endpoint",
    baseUrl: options.baseUrl,
    auth: {
      apiKey: envApiKeyAuth(
        "OpenAI-compatible API key",
        [OPENAI_COMPATIBLE_API_KEY_ENV_VAR],
      ),
    },
    getModels: () => [model],
    stream: streamOpenAICompletions,
    streamSimple: streamOpenAICompletionsSimple,
  };
}
