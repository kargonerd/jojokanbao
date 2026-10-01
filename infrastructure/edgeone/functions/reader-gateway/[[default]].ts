const DEFAULT_AGENT_URL = "https://agent-global.jojokanbao.cn/rag";
const DEFAULT_TIMES_AGENT_URL = "https://agent-global.jojokanbao.cn/times";
const MAX_RAG_REQUEST_BYTES = 64 * 1024;
const MAX_TIMES_REQUEST_BYTES = 6 * 1024 * 1024;
const FORWARDED_HEADERS = [
  "Accept",
  "Authorization",
  "Content-Type",
  "Makers-Conversation-Id",
] as const;

type ReaderGatewayContext = {
  env?: Readonly<Record<string, string | undefined>>;
  request: Request;
};

/**
 * Summarise a failed upstream `fetch` for the platform log and the failure
 * header. EdgeOne surfaces a generic "TypeError: fetch failed"; the useful
 * detail (ENOTFOUND / ECONNREFUSED / TLS) only exists on `error.cause`.
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
  const upstreamInit: RequestInit = {
    method: context.request.method,
    headers,
    body,
    redirect: "manual",
    signal: context.request.signal,
  };
  let upstream: Response;
  try {
    upstream = await fetch(target, upstreamInit);
  } catch (error) {
    // The relay has no timeout of its own; a failure here is a transport-level
    // error (DNS / TLS / refused). Keep the cause in the platform log and on the
    // response so a future investigation does not have to guess.
    const reason = describeFetchError(error);
    console.error("reader-gateway upstream failed", { target: target.origin, reason });
    return Response.json({ error: "问答服务暂时不可用" }, {
      status: 502,
      headers: { "X-JOJO-Gateway-Failure": encodeURIComponent(reason).slice(0, 400) },
    });
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
