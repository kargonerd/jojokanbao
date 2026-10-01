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
export const OPENAI_COMPATIBLE_INPUT_ENV_VAR = "JOJO_AGENT_MODEL_INPUT";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const INPUT_MODALITIES = ["text", "image"] as const;

export type OpenAICompatibleInputModality = typeof INPUT_MODALITIES[number];

/**
 * The endpoint does not publish a capability catalog, so the operator declares
 * what the configured model accepts. Defaulting to image matters for the Times
 * agent, which attaches up to four article images; declaring text-only makes the
 * handler reject those requests outright. Override with
 * `JOJO_AGENT_MODEL_INPUT=text` when the model has no vision support.
 */
export function parseModelInput(value: string | undefined): OpenAICompatibleInputModality[] {
  if (value === undefined || value.trim() === "") return [...INPUT_MODALITIES];
  const parsed: OpenAICompatibleInputModality[] = [];
  for (const entry of value.split(",")) {
    const token = entry.trim().toLowerCase();
    if (!token) continue;
    if (!INPUT_MODALITIES.includes(token as OpenAICompatibleInputModality)) {
      throw new Error(
        `${OPENAI_COMPATIBLE_INPUT_ENV_VAR} only accepts ${INPUT_MODALITIES.join(" or ")}: ${entry.trim()}`,
      );
    }
    const modality = token as OpenAICompatibleInputModality;
    if (!parsed.includes(modality)) parsed.push(modality);
  }
  if (!parsed.length) {
    throw new Error(`${OPENAI_COMPATIBLE_INPUT_ENV_VAR} must list at least one modality`);
  }
  return parsed;
}

export interface OpenAICompatibleProviderOptions {
  baseUrl: string;
  model: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: readonly OpenAICompatibleInputModality[];
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
    input: [...(options.input ?? INPUT_MODALITIES)],
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
