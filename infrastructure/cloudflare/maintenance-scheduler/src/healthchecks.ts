import type { HealthcheckDefinition } from "./types";

export type HealthcheckSignal = "success" | "start" | "fail";

interface HealthchecksOptions {
  fetcher?: typeof fetch | undefined;
  payload?: Record<string, unknown>;
}

interface HealthchecksCheck {
  ping_url?: unknown;
}

interface CachedHealthcheck {
  apiKey: string;
  definition: string;
  pingUrl: Promise<string>;
}

const HEALTHCHECKS_CHECKS_API = "https://healthchecks.io/api/v3/checks/";
const healthcheckCache = new Map<string, CachedHealthcheck>();

function signalUrl(pingUrl: string, signal: HealthcheckSignal): URL {
  const normalized = pingUrl.trim();
  if (!normalized) {
    throw new Error("Healthchecks ping URL is not configured");
  }

  const url = new URL(normalized);
  if (url.protocol !== "https:") {
    throw new Error("Healthchecks ping URL must use HTTPS");
  }
  if (signal !== "success") {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${signal}`;
  }
  return url;
}

async function upsertHealthcheck(
  definition: HealthcheckDefinition,
  apiKey: string,
  options: Pick<HealthchecksOptions, "fetcher"> = {},
): Promise<string> {
  if (!apiKey.trim()) {
    throw new Error("Healthchecks API key is not configured");
  }

  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(HEALTHCHECKS_CHECKS_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
    },
    body: JSON.stringify({
      name: definition.name,
      slug: definition.slug,
      tags: definition.tags,
      desc: definition.description,
      schedule: definition.schedule,
      tz: definition.timeZone,
      grace: definition.graceSeconds,
      methods: "POST",
      channels: "*",
      unique: ["slug"],
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Healthchecks check upsert failed with HTTP ${response.status}`);
  }

  const check = await response.json<HealthchecksCheck>();
  if (typeof check.ping_url !== "string") {
    throw new Error("Healthchecks check upsert returned no ping URL");
  }
  signalUrl(check.ping_url, "success");
  return check.ping_url;
}

export async function ensureHealthcheck(
  definition: HealthcheckDefinition,
  apiKey: string,
  options: Pick<HealthchecksOptions, "fetcher"> = {},
): Promise<string> {
  if (options.fetcher) {
    return upsertHealthcheck(definition, apiKey, options);
  }

  const serializedDefinition = JSON.stringify(definition);
  const cached = healthcheckCache.get(definition.slug);
  if (cached?.apiKey === apiKey && cached.definition === serializedDefinition) {
    return cached.pingUrl;
  }

  const pingUrl = upsertHealthcheck(definition, apiKey).catch((error: unknown) => {
    const current = healthcheckCache.get(definition.slug);
    if (current?.pingUrl === pingUrl) {
      healthcheckCache.delete(definition.slug);
    }
    throw error;
  });
  healthcheckCache.set(definition.slug, {
    apiKey,
    definition: serializedDefinition,
    pingUrl,
  });
  return pingUrl;
}

export async function pingHealthcheck(
  pingUrl: string,
  signal: HealthcheckSignal,
  options: HealthchecksOptions = {},
): Promise<void> {
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(signalUrl(pingUrl, signal), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options.payload ?? {}),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Healthchecks ${signal} ping failed with HTTP ${response.status}`);
  }
}

export async function reportHealthcheckBestEffort(
  definition: HealthcheckDefinition,
  apiKey: string | undefined,
  signal: HealthcheckSignal,
  options: HealthchecksOptions = {},
): Promise<void> {
  if (!apiKey?.trim()) {
    console.warn(`Healthchecks API key is not configured; skipped ${definition.slug}`);
    return;
  }

  try {
    const pingUrl = await ensureHealthcheck(definition, apiKey, options);
    await pingHealthcheck(pingUrl, signal, options);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "healthchecks_report_failed",
        taskId: definition.slug,
        signal,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

export async function provisionHealthcheckBestEffort(
  definition: HealthcheckDefinition,
  apiKey: string | undefined,
  options: Pick<HealthchecksOptions, "fetcher"> = {},
): Promise<void> {
  if (!apiKey?.trim()) {
    return;
  }

  try {
    await ensureHealthcheck(definition, apiKey, options);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "healthchecks_provision_failed",
        taskId: definition.slug,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
