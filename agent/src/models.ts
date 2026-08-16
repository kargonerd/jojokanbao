import {
  createModels,
  type AuthCheck,
  type AuthContext,
  type CredentialStore,
  type Model,
  type Models,
  type MutableModels,
  type OAuthCredential,
  type Provider,
} from "@earendil-works/pi-ai";
import {
  stream as streamOpenAICodex,
  streamSimple as streamOpenAICodexSimple,
} from "@earendil-works/pi-ai/api/openai-codex-responses";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

export type AgentEnvironment = Readonly<Record<string, string | undefined>>;

export interface PlatformModelConfig {
  provider: "openai-codex";
  model: string;
}

export interface PlatformModelRuntime {
  config: PlatformModelConfig;
  models: Models;
  model: Model<any>;
  configured: boolean;
  auth?: AuthCheck;
}

export const DEFAULT_CODEX_MODEL = "gpt-5.6-luna";
export const DEFAULT_CODEX_REASONING = "low" as const;

const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";

async function refreshOpenAICodexCredential(
  credential: OAuthCredential,
  signal?: AbortSignal,
): Promise<OAuthCredential> {
  const response = await fetch(OPENAI_CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credential.refresh,
      client_id: OPENAI_CODEX_CLIENT_ID,
    }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `OpenAI Codex token refresh failed (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  const token = await response.json() as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };
  if (
    typeof token.access_token !== "string"
    || typeof token.refresh_token !== "string"
    || typeof token.expires_in !== "number"
  ) {
    throw new Error("OpenAI Codex token refresh response is incomplete");
  }
  return {
    type: "oauth",
    access: token.access_token,
    refresh: token.refresh_token,
    expires: Date.now() + token.expires_in * 1_000,
  };
}

function edgeCompatibleOpenAICodexProvider(): Provider<"openai-codex-responses"> {
  const provider = openaiCodexProvider();
  return {
    ...provider,
    auth: {
      oauth: {
        name: "OpenAI (ChatGPT Plus/Pro)",
        login: async () => {
          throw new Error("Use the JOJO credential admin to configure OpenAI Codex");
        },
        refresh: refreshOpenAICodexCredential,
        toAuth: async (credential) => ({ apiKey: credential.access }),
      },
    },
    stream: streamOpenAICodex,
    streamSimple: streamOpenAICodexSimple,
  };
}

export function resolvePlatformModelConfig(
  environment: AgentEnvironment,
): PlatformModelConfig {
  return {
    provider: "openai-codex",
    model: environment.JOJO_AGENT_MODEL?.trim() || DEFAULT_CODEX_MODEL,
  };
}

export function createPlatformModels(options: {
  credentials?: CredentialStore;
  environment?: AgentEnvironment;
} = {}): MutableModels {
  const environment = options.environment ?? process.env;
  const authContext: AuthContext = {
    env: async (name) => environment[name],
    fileExists: async () => false,
  };
  const models = createModels({
    ...(options.credentials ? { credentials: options.credentials } : {}),
    authContext,
  });
  models.setProvider(edgeCompatibleOpenAICodexProvider());
  return models;
}

export async function createPlatformModelRuntime(options: {
  config: PlatformModelConfig;
  credentials?: CredentialStore;
  environment?: AgentEnvironment;
}): Promise<PlatformModelRuntime> {
  const models = createPlatformModels(options);
  const model = models.getModel(options.config.provider, options.config.model);
  if (!model) {
    throw new Error(
      `Pi model catalog does not contain ${options.config.provider}/${options.config.model}`,
    );
  }
  const auth = await models.checkAuth(options.config.provider);
  return {
    config: options.config,
    models,
    model,
    configured: auth !== undefined,
    ...(auth ? { auth } : {}),
  };
}

export function modelRuntimeStream(runtime: PlatformModelRuntime) {
  return runtime.models.streamSimple.bind(runtime.models);
}
