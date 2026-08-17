interface FeatureFlagRule {
  bucketBy?: unknown;
  bucketSalt?: unknown;
  conditionType?: unknown;
  enabled?: unknown;
  endsAt?: unknown;
  id?: unknown;
  percentage?: unknown;
  serve?: unknown;
  startsAt?: unknown;
  userIds?: unknown;
}

interface FeatureFlagConfig {
  key?: unknown;
  revision?: unknown;
  rules?: unknown;
}

const encoder = new TextEncoder();

function optionalTimestamp(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new Error("Invalid rule window");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("Invalid rule window");
  return timestamp;
}

function activeAt(rule: FeatureFlagRule, now: number): boolean {
  if (typeof rule.enabled !== "boolean") throw new Error("Invalid rule enabled");
  if (!rule.enabled) return false;
  const startsAt = optionalTimestamp(rule.startsAt);
  const endsAt = optionalTimestamp(rule.endsAt);
  return (startsAt === null || now >= startsAt)
    && (endsAt === null || now < endsAt);
}

async function percentageMatches(
  rule: FeatureFlagRule,
  flagKey: string,
  userId: string,
): Promise<boolean> {
  if (rule.bucketBy === "visitor") return false;
  if (
    rule.bucketBy !== "user"
    || typeof rule.id !== "string"
    || typeof rule.bucketSalt !== "string"
    || !Number.isInteger(rule.percentage)
    || Number(rule.percentage) < 1
    || Number(rule.percentage) > 100
  ) {
    throw new Error("Invalid percentage rule");
  }
  const source = [
    flagKey,
    rule.id,
    rule.bucketSalt,
    `user:${userId}`,
  ].join(":");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(source),
  );
  const bucket = new DataView(digest).getUint32(0, false) % 100;
  return bucket < Number(rule.percentage);
}

export async function evaluateAuthenticatedFeatureFlag(
  payload: unknown,
  flagKey: string,
  userId: string,
): Promise<boolean> {
  if (!payload || typeof payload !== "object") {
    throw new Error("Feature flag is missing");
  }
  const config = payload as FeatureFlagConfig;
  if (
    config.key !== flagKey
    || !Number.isInteger(config.revision)
    || Number(config.revision) < 1
    || !Array.isArray(config.rules)
    || config.rules.length === 0
  ) {
    throw new Error("Invalid feature flag config");
  }

  const now = Date.now();
  for (const value of config.rules) {
    if (!value || typeof value !== "object") throw new Error("Invalid rule");
    const rule = value as FeatureFlagRule;
    if (!activeAt(rule, now)) continue;
    if (typeof rule.serve !== "boolean") throw new Error("Invalid rule result");

    let matches = false;
    switch (rule.conditionType) {
      case "global":
      case "authenticated":
        matches = true;
        break;
      case "users":
        if (!Array.isArray(rule.userIds) || !rule.userIds.every((id) => typeof id === "string")) {
          throw new Error("Invalid users rule");
        }
        matches = rule.userIds.includes(userId);
        break;
      case "percentage":
        matches = await percentageMatches(rule, flagKey, userId);
        break;
      default:
        throw new Error("Invalid rule condition");
    }
    if (matches) return rule.serve;
  }
  return false;
}
