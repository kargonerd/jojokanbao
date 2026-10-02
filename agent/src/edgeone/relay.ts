/**
 * Shared relay used by the unified Agent entry point (`/ask`, `/ask/times`).
 *
 * The relay exists because `/rag` and `/times` are EdgeOne Makers *agents*
 * routes: the platform runs its own preflight on them (it demands
 * `Makers-Conversation-Id` and rejects any non-POST method with 400
 * `Invalid makers-conversation-id`) before our code executes. A browser that
 * sends `Authorization` must first issue an `OPTIONS` preflight, which can
 * never satisfy that rule, so browsers can never reach `/rag` directly.
 *
 * A plain Edge Function has no such preflight, so it can answer `OPTIONS`
 * itself and let every client share one origin and one path.
 *
 * The relay is a pure pass-through: it forwards a small header allowlist plus
 * the body and returns the upstream `ReadableStream` untouched. It never reads
 * the access token — authentication stays in the Agent middleware and the
 * Agent handler, which both validate the Supabase bearer token.
 */

export const DEFAULT_AGENT_ASK_URL = "https://agent-global.jojokanbao.cn/rag";
export const DEFAULT_AGENT_TIMES_URL = "https://agent-global.jojokanbao.cn/times";

const MAX_ASK_REQUEST_BYTES = 64 * 1024;
const MAX_TIMES_REQUEST_BYTES = 6 * 1024 * 1024;

// Edge functions default a `fetch` to a 15s response timeout, which can be
// shorter than the agent's time-to-first-byte (Supabase auth + usage accounting
// + the model's first token all happen before response headers). Raise the read
// and write budgets to the platform maximum (300s) and keep the connect budget
// tight; client aborts still travel through `context.request.signal`.
const UPSTREAM_CONNECT_TIMEOUT_MS = 15_000;
const UPSTREAM_READ_TIMEOUT_MS = 300_000;
const UPSTREAM_WRITE_TIMEOUT_MS = 300_000;

const FORWARDED_REQUEST_HEADERS = [
  "Accept",
  "Authorization",
  "Content-Type",
  "Makers-Conversation-Id",
] as const;

const FORWARDED_RESPONSE_HEADERS = [
  "Cache-Control",
  "Content-Type",
  "Retry-After",
  "X-Accel-Buffering",
  "X-Request-ID",
] as const;

/**
 * Answered by the relay itself rather than forwarded, so browsers can complete
 * their preflight against a route the platform does not gate. Development
 * origins stay allowed so `pnpm dev` works against the deployed entry point.
 */
const ALLOWED_ORIGINS = new Set([
  "https://reader.jojokanbao.cn",
  "https://beta.jojokanbao.cn",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

export interface RelayEnvironment {
  readonly [key: string]: string | undefined;
}

export interface RelayContext {
  env?: RelayEnvironment;
  request: Request;
}

/** EdgeOne extension on the standard `RequestInit`. */
type EdgeFetchInit = RequestInit & {
  eo?: {
    timeoutSetting?: {
      connectTimeout?: number;
      readTimeout?: number;
      writeTimeout?: number;
    };
  };
};

function allowedOrigin(request: Request): string | undefined {
  const origin = request.headers.get("Origin")?.trim();
  return origin && ALLOWED_ORIGINS.has(origin) ? origin : undefined;
}

function corsHeaders(request: Request): Record<string, string> {
  const origin = allowedOrigin(request);
  if (!origin) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, makers-conversation-id",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

/**
 * Build a JSON response without `Response.json()`.
 *
 * The EdgeOne edge runtime throws on `Response.json(...)` — the request fails
 * with HTTP 545 "Error return from script", deterministically and for every
 * status code. Verified on a live preview deployment: a handler branch using
 * `Response.json()` returned 545 while `new Response(JSON.stringify(...))` and
 * a plain-text `new Response(...)` on the same route returned their status
 * normally. `Response.json` is therefore unusable here and every JSON response
 * in this module goes through this helper.
 */
function json(
  body: unknown,
  init: { status: number; headers?: Record<string, string> },
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...init.headers },
  });
}

/**
 * Summarise a failed upstream `fetch` for the platform log. EdgeOne surfaces a
 * generic "TypeError: fetch failed"; the useful detail (ENOTFOUND /
 * ECONNREFUSED / TLS) only exists on `error.cause`. Keeping it in the log means
 * a future investigation does not have to guess.
 */
function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const parts = [`${error.name}: ${error.message}`];
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    parts.push(`cause=${cause.name}: ${cause.message}`);
    for (const key of ["code", "errno", "syscall", "hostname"] as const) {
      const value = (cause as unknown as Record<string, unknown>)[key];
      if (value !== undefined) parts.push(`${key}=${String(value)}`);
    }
  } else if (cause !== undefined) {
    parts.push(`cause=${String(cause)}`);
  }
  return parts.join(" | ");
}

async function relay(
  context: RelayContext,
  options: { target: string; maxBytes: number; label: string },
): Promise<Response> {
  const cors = corsHeaders(context.request);

  // The browser preflight must succeed here; the platform never sees it.
  if (context.request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (context.request.method !== "POST") {
    return json({ error: "Method not allowed" }, {
      status: 405,
      headers: { ...cors, Allow: "POST, OPTIONS" },
    });
  }

  let target: URL;
  try {
    target = new URL(options.target);
  } catch {
    return json({ error: "问答服务暂未配置" }, { status: 503, headers: cors });
  }
  if (target.protocol !== "https:") {
    return json({ error: "问答服务暂未配置" }, { status: 503, headers: cors });
  }

  const declaredLength = Number(context.request.headers.get("Content-Length") ?? "0");
  if (declaredLength > options.maxBytes) {
    return json({ error: "问答内容过长" }, { status: 413, headers: cors });
  }
  const body = await context.request.arrayBuffer();
  if (body.byteLength > options.maxBytes) {
    return json({ error: "问答内容过长" }, { status: 413, headers: cors });
  }

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = context.request.headers.get(name);
    if (value) headers.set(name, value);
  }

  const upstreamInit: EdgeFetchInit = {
    method: "POST",
    headers,
    body,
    redirect: "manual",
    signal: context.request.signal,
    eo: {
      timeoutSetting: {
        connectTimeout: UPSTREAM_CONNECT_TIMEOUT_MS,
        readTimeout: UPSTREAM_READ_TIMEOUT_MS,
        writeTimeout: UPSTREAM_WRITE_TIMEOUT_MS,
      },
    },
  };

  let upstream: Response;
  try {
    upstream = await fetch(target, upstreamInit);
  } catch (error) {
    const reason = describeFetchError(error);
    console.error("agent ask relay upstream failed", {
      label: options.label,
      target: target.origin,
      reason,
    });
    return json({ error: "问答服务暂时不可用" }, {
      status: 502,
      headers: { ...cors, "X-JOJO-Relay-Failure": encodeURIComponent(reason).slice(0, 400) },
    });
  }

  const responseHeaders = new Headers(cors);
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export function relayAskRequest(context: RelayContext): Promise<Response> {
  return relay(context, {
    target: context.env?.JOJO_AGENT_ASK_URL?.trim() || DEFAULT_AGENT_ASK_URL,
    maxBytes: MAX_ASK_REQUEST_BYTES,
    label: "ask",
  });
}

export function relayTimesRequest(context: RelayContext): Promise<Response> {
  return relay(context, {
    target: context.env?.JOJO_AGENT_TIMES_URL?.trim() || DEFAULT_AGENT_TIMES_URL,
    maxBytes: MAX_TIMES_REQUEST_BYTES,
    label: "times",
  });
}
