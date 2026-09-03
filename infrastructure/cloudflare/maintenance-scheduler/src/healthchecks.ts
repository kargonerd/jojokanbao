export type HealthcheckSignal = "success" | "start" | "fail";

interface PingOptions {
  fetcher?: typeof fetch | undefined;
  payload?: Record<string, unknown>;
}

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

export async function pingHealthcheck(
  pingUrl: string,
  signal: HealthcheckSignal,
  options: PingOptions = {},
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

export async function pingHealthcheckBestEffort(
  pingUrl: string | undefined,
  signal: HealthcheckSignal,
  options: PingOptions = {},
): Promise<void> {
  if (!pingUrl?.trim()) {
    console.warn("Healthchecks ping URL is not configured");
    return;
  }

  try {
    await pingHealthcheck(pingUrl, signal, options);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "healthchecks_ping_failed",
        signal,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
