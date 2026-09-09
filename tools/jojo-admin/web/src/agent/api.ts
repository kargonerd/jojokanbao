import { apiGet, apiPost } from "../lib/api";

export type AgentProvider = "openai-codex" | "antigravity";

export interface AgentCredentialStatus {
  provider: AgentProvider;
  operatorConfigured: boolean;
  serviceConfigured: boolean;
  targetOrigin: string | null;
  credential: {
    available: boolean;
    sourceLabel: string;
    pathHint: string;
    type: string | null;
    expiresAt: string | null;
    expired: boolean;
    error: string | null;
  };
  canPush: boolean;
}

export const agentAdminApi = {
  status: async (provider: AgentProvider) => {
    const result = await apiGet<{ success: true; status: AgentCredentialStatus }>(
      `/api/agent/credentials/status?provider=${encodeURIComponent(provider)}`,
    );
    return result.status;
  },
  pushCredential: async (provider: AgentProvider) => {
    const result = await apiPost<{
      success: true;
      result: { targetOrigin: string; pushedAt: string };
    }>("/api/agent/credentials/push", { provider });
    return result.result;
  },
};
