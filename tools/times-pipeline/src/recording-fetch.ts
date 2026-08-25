import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ProxyAgent, type Dispatcher } from "undici";
import type { RecordedExchange } from "./types.js";

const REDACTED_REQUEST_HEADERS = new Set(["authorization", "cookie", "proxy-authorization", "x-api-key"]);
const REDACTED_RESPONSE_HEADERS = new Set(["set-cookie"]);
const PROXY_RETRY_STATUSES = new Set([400, 401, 403, 429]);

export async function normalizeEncodedResponse(response: Response): Promise<Response> {
  const body = Buffer.from(await response.clone().arrayBuffer());
  if (body[0] !== 0x1f || body[1] !== 0x8b) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  const normalized = new Response(Uint8Array.from(gunzipSync(body)).buffer, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  Object.defineProperty(normalized, "url", { value: response.url });
  return normalized;
}

function safeHeaders(value: Headers | Record<string, string> | undefined, excluded: Set<string>): Record<string, string> {
  const headers = value instanceof Headers ? value : new Headers(value);
  return Object.fromEntries([...headers.entries()].filter(([name]) => !excluded.has(name.toLowerCase())));
}

function requestMetadata(input: RequestInfo | URL, init?: RequestInit): RecordedExchange["request"] {
  const source = input instanceof Request ? input : undefined;
  return {
    method: (init?.method ?? source?.method ?? "GET").toUpperCase(),
    url: source?.url ?? String(input),
    headers: safeHeaders(init?.headers as Record<string, string> | undefined ?? source?.headers, REDACTED_REQUEST_HEADERS),
  };
}

export class RecordingFetch {
  readonly exchanges: RecordedExchange[] = [];
  readonly pending = new Set<Promise<void>>();
  readonly nativeFetch: typeof globalThis.fetch;
  readonly networkRoot: string;
  readonly maxResponseBytes: number;
  #sequence = 0;

  constructor(runRoot: string, maxResponseBytes = 5_000_000) {
    this.nativeFetch = globalThis.fetch.bind(globalThis);
    this.networkRoot = path.join(runRoot, "network");
    this.maxResponseBytes = maxResponseBytes;
  }

  install(): () => void {
    const recorder = this;
    const proxyUri = process.env.JOJO_TIMES_PROXY_URI?.trim();
    const proxyAgent = proxyUri ? new ProxyAgent(proxyUri) : undefined;
    async function attempt(
      input: RequestInfo | URL,
      init?: RequestInit,
      dispatcher?: Dispatcher,
    ): Promise<Response> {
      const sequence = ++recorder.#sequence;
      const startedAt = new Date().toISOString();
      const request = requestMetadata(input, init);
      try {
        const attemptInit = dispatcher ? { ...init, dispatcher } as RequestInit : init;
        const response = await recorder.nativeFetch(input, attemptInit);
        const copy = response.clone();
        const capture = recorder.captureBody(sequence, startedAt, request, response, copy);
        recorder.pending.add(capture);
        void capture.finally(() => recorder.pending.delete(capture));
        return normalizeEncodedResponse(response);
      } catch (error) {
        recorder.exchanges.push({
          sequence,
          startedAt,
          finishedAt: new Date().toISOString(),
          request,
          error: error instanceof Error ? error.name : "FetchError",
        });
        throw error;
      }
    }
    globalThis.fetch = async function recordingFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      try {
        const direct = await attempt(input, init);
        if (!proxyAgent || !PROXY_RETRY_STATUSES.has(direct.status)) return direct;
      } catch (error) {
        if (!proxyAgent) throw error;
      }
      return attempt(input, init, proxyAgent);
    };
    return () => {
      globalThis.fetch = this.nativeFetch;
      if (proxyAgent) void proxyAgent.close();
    };
  }

  private async captureBody(
    sequence: number,
    startedAt: string,
    request: RecordedExchange["request"],
    response: Response,
    copy: Response,
  ): Promise<void> {
    try {
      const body = Buffer.from(await copy.arrayBuffer());
      const stored = body.subarray(0, this.maxResponseBytes);
      const digest = createHash("sha256").update(body).digest("hex");
      const relative = `network/bodies/${digest}.bin.gz`;
      const target = path.join(this.networkRoot, "bodies", `${digest}.bin.gz`);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, gzipSync(stored, { level: 9 }));
      this.exchanges.push({
        sequence,
        startedAt,
        finishedAt: new Date().toISOString(),
        request,
        response: {
          status: response.status,
          url: response.url,
          headers: safeHeaders(response.headers, REDACTED_RESPONSE_HEADERS),
          bodyObject: relative,
          bodySha256: digest,
          bodyBytes: body.byteLength,
          storedBytes: stored.byteLength,
          truncated: stored.byteLength < body.byteLength,
        },
      });
    } catch (error) {
      this.exchanges.push({
        sequence,
        startedAt,
        finishedAt: new Date().toISOString(),
        request,
        response: {
          status: response.status,
          url: response.url,
          headers: safeHeaders(response.headers, REDACTED_RESPONSE_HEADERS),
        },
        error: error instanceof Error ? error.name : "BodyCaptureError",
      });
    }
  }

  async flush(): Promise<string> {
    await Promise.all([...this.pending]);
    const target = path.join(this.networkRoot, "exchanges.jsonl.gz");
    await mkdir(path.dirname(target), { recursive: true });
    const payload = this.exchanges
      .sort((left, right) => left.sequence - right.sequence)
      .map((exchange) => JSON.stringify(exchange))
      .join("\n") + "\n";
    await writeFile(target, gzipSync(payload, { level: 9 }));
    return target;
  }
}
