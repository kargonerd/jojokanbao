import {
  createModels,
  type AuthCheck,
  type AuthContext,
  type CredentialStore,
  type Model,
  type Models,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

export type AgentDeploymentProfile = "domestic" | "international";
export type PlatformProviderId = "openai-codex" | "google" | "deepseek";
export type AgentEnvironment = Readonly<Record<string, string | undefined>>;

export interface PlatformModelConfig {
  profile: AgentDeploymentProfile;
  provider: PlatformProviderId;
  model: string;
}

export interface PlatformModelRuntime {
  config: PlatformModelConfig;
  models: Models;
  model: Model<any>;
  configured: boolean;
  auth?: AuthCheck;
}

const PROFILE_DEFAULTS: Record<
  AgentDeploymentProfile,
  Pick<PlatformModelConfig, "provider" | "model">
> = {
  domestic: {
    provider: "deepseek",
    model: "deepseek-v4-flash",
  },
  international: {
    provider: "openai-codex",
    model: "gpt-5.6-terra",
  },
};

const PROVIDER_ALIASES: Record<string, PlatformProviderId> = {
  codex: "openai-codex",
  "openai-codex": "openai-codex",
  gemini: "google",
  google: "google",
  deepseek: "deepseek",
};

export const PLATFORM_PROVIDER_ENV = {
  "openai-codex": "JOJO_AGENT_AUTH_JSON",
  google: "GEMINI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
} as const;

function deploymentProfile(value: string | undefined): AgentDeploymentProfile {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "domestic";
  if (normalized === "domestic" || normalized === "international") return normalized;
  throw new Error("JOJO_AGENT_PROFILE must be domestic or international");
}

function providerId(value: string | undefined, fallback: PlatformProviderId): PlatformProviderId {
  if (!value?.trim()) return fallback;
  const resolved = PROVIDER_ALIASES[value.trim().toLowerCase()];
  if (!resolved) {
    throw new Error("JOJO_AGENT_PROVIDER must be codex, gemini/google, or deepseek");
  }
  return resolved;
}

function fallbackModel(provider: PlatformProviderId): string {
  if (provider === "openai-codex") return PROFILE_DEFAULTS.international.model;
  if (provider === "google") return "gemini-3.5-flash";
  return PROFILE_DEFAULTS.domestic.model;
}

export function resolvePlatformModelConfig(
  environment: AgentEnvironment,
  defaultProfile?: AgentDeploymentProfile,
): PlatformModelConfig {
  const profile = deploymentProfile(
    environment.JOJO_AGENT_PROFILE ?? defaultProfile,
  );
  const defaults = PROFILE_DEFAULTS[profile];
  const provider = providerId(environment.JOJO_AGENT_PROVIDER, defaults.provider);
  const model = environment.JOJO_AGENT_MODEL?.trim() || fallbackModel(provider);
  return { profile, provider, model };
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
  models.setProvider(googleProvider());
  models.setProvider(deepseekProvider());
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
