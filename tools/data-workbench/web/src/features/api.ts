import { apiGet, apiPost } from "../lib/api";
import type { FeatureFlagDefinition, FeatureFlagRule, FeatureUser } from "./types";

export const featureFlagApi = {
  list: async () => {
    const result = await apiGet<{ success: true; flags: FeatureFlagDefinition[] }>("/api/features");
    return result.flags;
  },
  searchUsers: async (query: string) => {
    const result = await apiPost<{ success: true; users: FeatureUser[] }>("/api/features/users", { query });
    return result.users;
  },
  publish: async (input: {
    key: string;
    rules: FeatureFlagRule[];
    emergencyDisabled: boolean;
    expectedRevision: number;
    reason: string;
    requestId: string;
  }) => {
    const result = await apiPost<{ success: true; flag: FeatureFlagDefinition }>("/api/features/publish", input);
    return result.flag;
  },
};
