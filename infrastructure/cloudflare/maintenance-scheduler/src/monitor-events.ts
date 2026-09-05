import type { ExecutionEvent } from "./monitor-policy";

export interface LoggedPing { n: number; type: string; date: string; body_url: string | null }
const API = "https://healthchecks.io/api/v3/checks";

async function read(url: string, apiKey: string, fetcher: typeof fetch): Promise<Response> {
  const response = await fetcher(url, { headers: { "X-Api-Key": apiKey }, signal: AbortSignal.timeout(8000), redirect: "manual" });
  if (!response.ok) throw new Error(`Monitoring inbox request failed with HTTP ${response.status}`);
  return response;
}

export function checkUuid(pingUrl: string): string {
  const url = new URL(pingUrl);
  const uuid = url.pathname.slice(1);
  if (url.origin !== "https://hc-ping.com" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(uuid)) throw new Error("Invalid managed check identity");
  return uuid;
}

export async function listLoggedPings(uuid: string, apiKey: string, fetcher: typeof fetch = fetch): Promise<LoggedPing[]> {
  const response = await read(`${API}/${uuid}/pings/`, apiKey, fetcher);
  const payload = await response.json<{ pings?: LoggedPing[] }>();
  if (!Array.isArray(payload.pings) || payload.pings.length > 1000 || payload.pings.some((ping) =>
    !Number.isSafeInteger(ping.n) || ping.n <= 0 || !Number.isFinite(Date.parse(ping.date)) || typeof ping.type !== "string")) {
    throw new Error("Invalid monitoring inbox response");
  }
  const ordered = [...payload.pings].sort((a, b) => a.n - b.n);
  if (new Set(ordered.map((ping) => ping.n)).size !== ordered.length) throw new Error("Duplicate monitoring inbox sequence");
  return ordered;
}

export async function readLoggedBody(uuid: string, n: number, apiKey: string, fetcher: typeof fetch = fetch): Promise<string> {
  // Never follow a body_url from an API payload with our project credential.
  const response = await read(`${API}/${uuid}/pings/${n}/body`, apiKey, fetcher);
  if (Number(response.headers.get("content-length")) > 8192) throw new Error("Monitoring event body is too large");
  const body = await response.text();
  if (body.length > 8192) throw new Error("Monitoring event body is too large");
  return body;
}

export function parseExecution(body: string, slug: string, receivedAt: number, legacySuccess = false): ExecutionEvent | undefined {
  const fields = Object.fromEntries(body.split(/\r?\n/u).map((line) => {
    const index = line.indexOf("=");
    return index < 0 ? [line, ""] : [line.slice(0, index), line.slice(index + 1)];
  }));
  if (fields.monitor_event !== "v1") {
    // Accept only an attributable legacy workflow success during a staggered
    // rollout. Our JSON decision pings and arbitrary/manual pings are not work.
    const runId = fields.run?.match(/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/actions\/runs\/([1-9][0-9]*)$/u)?.[1];
    return legacySuccess && fields.task === slug && fields.status === "success" && runId
      ? { id: `legacy:${runId}`, at: receivedAt, outcome: "success", permanent: false, run: fields.run! }
      : undefined;
  }
  const at = Date.parse(fields.event_time ?? "");
  if (fields.task !== slug || !/^[1-9][0-9]*$/u.test(fields.run_id ?? "") || !/^[1-9][0-9]*$/u.test(fields.run_attempt ?? "") ||
    !Number.isFinite(at) || at > receivedAt + 60_000 || !["success", "failure"].includes(fields.outcome ?? "") ||
    !["unknown", "retryable", "permanent"].includes(fields.failure_class ?? "") || !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/actions\/runs\/[1-9][0-9]*$/u.test(fields.run ?? "") || !fields.run?.endsWith(`/runs/${fields.run_id}`)) {
    throw new Error(`Invalid buffered execution event for ${slug}`);
  }
  return {
    id: `${fields.run_id}:${fields.run_attempt}`,
    at,
    outcome: fields.outcome as "success" | "failure",
    permanent: fields.failure_class === "permanent",
    run: fields.run!,
  };
}
