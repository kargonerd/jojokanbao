const DEFAULT_AGENT_URL = "https://agent-global.jojokanbao.cn/rag";
const DEFAULT_TIMES_AGENT_URL = "https://agent-global.jojokanbao.cn/times";
const MAX_RAG_REQUEST_BYTES = 64 * 1024;
const MAX_TIMES_REQUEST_BYTES = 6 * 1024 * 1024;
// EdgeOne edge functions default a `fetch` to a 15s timeout. The agent can take
// longer than that before it sends response headers (Supabase auth + usage
// accounting + the model's first byte), and this relay would then answer the
// browser with 502 「问答服务暂时不可用」 while the agent is still working.
// Keep the upstream budget at the platform maximum and leave client aborts to
// `context.request.signal`.
const UPSTREAM_READ_TIMEOUT_MS = 300_000;
const UPSTREAM_WRITE_TIMEOUT_MS = 300_000;
const UPSTREAM_CONNECT_TIMEOUT_MS = 15_000;
const FORWARDED_HEADERS = [
  "Accept",
  "Authorization",
  "Content-Type",
  "Makers-Conversation-Id",
] as const;

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

type ReaderGatewayContext = {
  env?: Readonly<Record<string, string | undefined>>;
  request: Request;
};

export async function onRequest(context: ReaderGatewayContext): Promise<Response> {
  const incoming = new URL(context.request.url);
  const pathname = incoming.pathname.replace(/\/+$/, "");
  const route = pathname === "/gateway/ask"
    ? {
      target: context.env?.JOJO_AGENT_URL?.trim() || DEFAULT_AGENT_URL,
      maxBytes: MAX_RAG_REQUEST_BYTES,
    }
    : pathname === "/gateway/times/explain"
      ? {
        target: context.env?.JOJO_TIMES_AGENT_URL?.trim() || DEFAULT_TIMES_AGENT_URL,
        maxBytes: MAX_TIMES_REQUEST_BYTES,
      }
      : undefined;
  if (!route) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  if (context.request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, {
      status: 405,
      headers: { Allow: "POST" },
    });
  }

  let target: URL;
  try {
    const agent = new URL(
      route.target,
    );
    target = agent;
  } catch {
    return Response.json({ error: "问答服务暂未配置" }, { status: 503 });
  }
  if (target.protocol !== "https:") {
    return Response.json({ error: "问答服务暂未配置" }, { status: 503 });
  }
  const declaredLength = Number(context.request.headers.get("Content-Length") ?? "0");
  if (declaredLength > route.maxBytes) {
    return Response.json({ error: "问答内容过长" }, { status: 413 });
  }
  const body = await context.request.arrayBuffer();
  if (body.byteLength > route.maxBytes) {
    return Response.json({ error: "问答内容过长" }, { status: 413 });
  }
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = context.request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const upstreamInit: EdgeFetchInit = {
    method: context.request.method,
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
    // Without the explicit timeout above this branch fires after 15s even when
    // the agent is still healthy, which made slow-model answers look like an
    // outage. Keep the cause in the platform log so the next investigation does
    // not have to guess.
    console.error("reader-gateway upstream failed", {
      target: target.origin,
      reason: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
    return Response.json({ error: "问答服务暂时不可用" }, { status: 502 });
  }
  const responseHeaders = new Headers();
  for (const name of [
    "Cache-Control",
    "Content-Type",
    "Retry-After",
    "X-Accel-Buffering",
    "X-Request-ID",
  ]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}
