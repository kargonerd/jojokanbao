const DEFAULT_AGENT_URL = "https://agent-global.jojokanbao.cn/rag";
const MAX_REQUEST_BYTES = 64 * 1024;
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

export async function onRequest(context: ReaderGatewayContext): Promise<Response> {
  const incoming = new URL(context.request.url);
  const pathname = incoming.pathname.replace(/\/+$/, "");
  if (pathname !== "/gateway/ask") {
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
      context.env?.JOJO_AGENT_URL?.trim() || DEFAULT_AGENT_URL,
    );
    target = agent;
  } catch {
    return Response.json({ error: "问答服务暂未配置" }, { status: 503 });
  }
  if (target.protocol !== "https:") {
    return Response.json({ error: "问答服务暂未配置" }, { status: 503 });
  }
  const declaredLength = Number(context.request.headers.get("Content-Length") ?? "0");
  if (declaredLength > MAX_REQUEST_BYTES) {
    return Response.json({ error: "问答内容过长" }, { status: 413 });
  }
  const body = await context.request.arrayBuffer();
  if (body.byteLength > MAX_REQUEST_BYTES) {
    return Response.json({ error: "问答内容过长" }, { status: 413 });
  }
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = context.request.headers.get(name);
    if (value) headers.set(name, value);
  }
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: context.request.method,
      headers,
      body,
      redirect: "manual",
      signal: context.request.signal,
    });
  } catch {
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
