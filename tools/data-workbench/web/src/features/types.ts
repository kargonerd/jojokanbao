export type FeatureConditionType = "users" | "percentage" | "authenticated" | "global";

export interface FeatureFlagRule {
  id?: string;
  name: string;
  conditionType: FeatureConditionType;
  serve: boolean;
  percentage: number | null;
  bucketBy: "user" | "visitor" | null;
  bucketSalt: string | null;
  startsAt: string | null;
  endsAt: string | null;
  enabled: boolean;
  isFallback: boolean;
  userIds: string[];
}

export interface FeatureFlagDefinition {
  key: string;
  description: string;
  revision: number;
  updatedAt: string;
  updatedBy: string | null;
  rules: FeatureFlagRule[];
}

export interface FeatureUser {
  user_id: string;
  display_name: string | null;
  email: string | null;
}
