import {
  createModels,
  type AuthCheck,
  type AuthContext,
  type CredentialStore,
  type Model,
  type Models,
  type MutableModels,
} from "@earendil-works/pi-ai";
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
  models.setProvider(openaiCodexProvider());
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
