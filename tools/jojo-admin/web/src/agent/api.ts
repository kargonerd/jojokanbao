import { apiGet, apiPost } from "../lib/api";

export interface AgentCredentialStatus {
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
  status: async () => {
    const result = await apiGet<{ success: true; status: AgentCredentialStatus }>(
      "/api/agent/credentials/status",
    );
    return result.status;
  },
  pushCredential: async () => {
    const result = await apiPost<{
      success: true;
      result: { targetOrigin: string; pushedAt: string };
    }>("/api/agent/credentials/push");
    return result.result;
  },
};
