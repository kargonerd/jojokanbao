import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { EdgeOneTraceAttributes } from "./types";

const processId = randomUUID();
const TIMEOUT_MS = 3_000;
const MAX_RESPONSE_BYTES = 4_096;
const TARGETS = {
  ipify: "https://api64.ipify.org?format=json",
  cloudflare: "https://www.cloudflare.com/cdn-cgi/trace",
} as const;

export interface EgressObservation {
  source: keyof typeof TARGETS;
  status: "ok" | "timeout" | "aborted" | "http_error" | "invalid_response" | "network_error";
  ip?: string;
  family?: number;
  country?: string;
  httpStatus?: number;
}

export interface EgressDiagnostics {
  processId: string;
  observedAt: string;
  durationMs: number;
  observations: EgressObservation[];
}

async function limitedText(response: Response, signal: AbortSignal): Promise<string> {
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new Error("invalid_response");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("invalid_response");
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("invalid_response");
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
  }
}

async function observe(
  source: EgressObservation["source"],
  signal: AbortSignal | undefined,
  fetcher: typeof fetch,
): Promise<EgressObservation> {
  const cancellation = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<EgressObservation>((resolve) => {
    const finish = (status: "timeout" | "aborted") => {
      cancellation.abort();
      resolve({ source, status });
    };
    timer = setTimeout(() => finish("timeout"), TIMEOUT_MS);
    onAbort = () => finish("aborted");
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
  const request = (async (): Promise<EgressObservation> => {
    try {
      cancellation.signal.throwIfAborted();
      // Fixed destinations, no incoming headers, cookies, prompts or credentials.
      // This uses the Agent process's global fetch, as Antigravity does on Node 22+.
      const response = await fetcher(TARGETS[source], {
        signal: cancellation.signal,
        redirect: "error",
        credentials: "omit",
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        return { source, status: "http_error", httpStatus: response.status };
      }
      const text = await limitedText(response, cancellation.signal);
      let fields: Record<string, unknown>;
      try {
        fields = source === "ipify" ? JSON.parse(text) : Object.fromEntries(
          text.trim().split(/\r?\n/u).map((line) => {
            const separator = line.indexOf("=");
            return [line.slice(0, separator), line.slice(separator + 1)];
          }),
        );
      } catch {
        return { source, status: "invalid_response" };
      }
      const ip = typeof fields?.ip === "string" ? fields.ip.trim() : "";
      const family = isIP(ip);
      if (!family) return { source, status: "invalid_response" };
      const country = source === "cloudflare" && typeof fields.loc === "string"
        && /^[A-Z]{2}$/u.test(fields.loc) ? fields.loc : undefined;
      return { source, status: "ok", ip, family, ...(country ? { country } : {}) };
    } catch (error) {
      // Never retain third-party payloads or exception messages in telemetry.
      return { source, status: error instanceof Error && error.message === "invalid_response"
        ? "invalid_response" : "network_error" };
    }
  })();
  try {
    // Bound total time even if a fetch implementation ignores AbortSignal.
    return await Promise.race([interrupted, request]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

export async function collectEgressDiagnostics(
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<EgressDiagnostics> {
  const started = Date.now();
  const observations = await Promise.all(
    (Object.keys(TARGETS) as EgressObservation["source"][])
      .map((source) => observe(source, signal, fetcher)),
  );
  return { processId, observedAt: new Date(started).toISOString(), durationMs: Date.now() - started, observations };
}

export function egressTraceAttributes(diagnostics: EgressDiagnostics): EdgeOneTraceAttributes {
  const attributes: EdgeOneTraceAttributes = {
    "agent.process_id": diagnostics.processId,
    "agent.egress.observed_at": diagnostics.observedAt,
    "agent.egress.duration_ms": diagnostics.durationMs,
  };
  for (const observation of diagnostics.observations) {
    for (const [key, value] of Object.entries(observation)) {
      if (key !== "source") attributes[`agent.egress.${observation.source}.${key}`] = value;
    }
  }
  return attributes;
}
