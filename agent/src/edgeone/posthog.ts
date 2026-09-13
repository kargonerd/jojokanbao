import { PostHog } from "posthog-node";

export interface AgentUsageLimits { requestsPerMinute: number; requestsPerDay: number; maxRunSeconds: number }
export function parseAgentUsageLimits(value: unknown): AgentUsageLimits | undefined {
  if (!value || typeof value !== "object") return;
  const config = value as AgentUsageLimits;
  if (!Number.isInteger(config.requestsPerMinute) || config.requestsPerMinute < 1 || config.requestsPerMinute > 60
    || !Number.isInteger(config.requestsPerDay) || config.requestsPerDay < 1 || config.requestsPerDay > 10_000
    || !Number.isInteger(config.maxRunSeconds) || config.maxRunSeconds < 30 || config.maxRunSeconds > 600) return;
  return { requestsPerMinute: config.requestsPerMinute, requestsPerDay: config.requestsPerDay, maxRunSeconds: config.maxRunSeconds };
}

export class AgentUsageConfig {
  private value?: AgentUsageLimits;
  private pending?: Promise<void>;
  private refreshAfter = 0;
  constructor(private readonly client: Pick<PostHog, "getAllFlagsAndPayloads">) {}

  async get(): Promise<AgentUsageLimits> {
    if (!this.pending && Date.now() >= this.refreshAfter) {
      this.refreshAfter = Date.now() + 30_000;
      this.pending = this.client.getAllFlagsAndPayloads("jojo-public-config", { personProperties: { signed_in: false } })
        .then((result) => {
          const value = parseAgentUsageLimits(result.featureFlagPayloads?.ai_usage_limits_config);
          if (result.featureFlags?.ai_usage_limits_config === true && value) {
            this.value = value;
            this.refreshAfter = Date.now() + 300_000;
          }
        }).catch(() => undefined).finally(() => { this.pending = undefined; });
    }
    if (!this.value) await this.pending;
    if (!this.value) throw new Error("PostHog AI limits unavailable");
    return { ...this.value };
  }
}

let configured: { key: string; config: AgentUsageConfig; client: PostHog } | undefined;
export async function getAgentUsageLimits(env: Record<string, string | undefined>): Promise<AgentUsageLimits> {
  const token = env.POSTHOG_PROJECT_TOKEN?.trim();
  const host = env.POSTHOG_API_HOST?.trim() || "https://us.i.posthog.com";
  const url = new URL(host);
  if (!token || url.protocol !== "https:" || url.username || url.password) throw new Error("PostHog configuration missing");
  const key = `${host}:${token}`;
  if (configured?.key !== key) {
    if (configured) void configured.client.shutdown();
    const client = new PostHog(token, { host, requestTimeout: 3_000, featureFlagsRequestTimeoutMs: 3_000, fetchRetryCount: 0, before_send: () => null });
    configured = { key, client, config: new AgentUsageConfig(client) };
  }
  return configured.config.get();
}
