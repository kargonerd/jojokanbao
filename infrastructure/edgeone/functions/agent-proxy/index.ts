import {
  createAgentServiceSignatureHeaders,
} from "@jojo/agent/edgeone/service-auth";

const CONVERSATION_HEADER = "Makers-Conversation-Id";
const CONVERSATION_ID = /^[0-9A-Za-z._-]{6,36}$/;
const MAX_REQUEST_BYTES = 64 * 1024;

export interface AgentProxyContext {
  env?: Readonly<Record<string, string | undefined>>;
  request: Request;
}

function configuredOrigins(
  environment: Readonly<Record<string, string | undefined>>,
): Set<string> {
  const value = environment.JOJO_AGENT_ALLOWED_ORIGINS
    ?? environment.JOJO_ALLOWED_ORIGINS
    ?? "";
  return new Set(
    value
      .split(",")
      .map((origin) => origin.trim().replace(/\/$/, ""))
      .filter(Boolean),
  );
}

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers({
    "Access-Control-Allow-Headers": [
      "Authorization",
      "Content-Type",
      CONVERSATION_HEADER,
    ].join(", "),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Expose-Headers": "Retry-After",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  });
  if (origin) headers.set("Access-Control-Allow-Origin", origin);
  return headers;
}

function jsonResponse(
  status: number,
  body: Record<string, unknown>,
  origin: string | null,
): Response {
  const headers = corsHeaders(origin);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers });
}

function copyUpstreamHeaders(upstream: Response, origin: string | null): Headers {
  const headers = corsHeaders(origin);
  for (const name of [
    "cache-control",
    "content-type",
    "retry-after",
    "x-accel-buffering",
  ]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function agentUrl(
  environment: Readonly<Record<string, string | undefined>>,
  requestUrl: string,
  health: boolean,
): URL {
  const configured = environment.JOJO_AGENT_UPSTREAM_URL?.trim();
  const target = configured
    ? new URL(configured)
    : new URL("/jojo", requestUrl);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("JOJO_AGENT_UPSTREAM_URL must use http or https");
  }
  target.pathname = health
    ? `${target.pathname.replace(/\/$/, "")}/health`
    : target.pathname.replace(/\/$/, "");
  target.search = "";
  target.hash = "";
  return target;
}

/**
 * Cross-origin adapter implementation for the standalone international Makers project.
 *
 * Browsers cannot attach Makers-Conversation-Id to their CORS preflight, while
 * Makers Agent routes require it before invoking user code. A Cloud Function
 * handles OPTIONS, then forwards the real request to the same project's Agent.
 */
export async function onRequest(
  context: AgentProxyContext,
): Promise<Response> {
  const environment = context.env ?? process.env;
  const request = context.request;
  const origin = request.headers.get("origin")?.replace(/\/$/, "") ?? null;
  if (origin && !configuredOrigins(environment).has(origin)) {
    return jsonResponse(403, { error: "Origin is not allowed" }, null);
  }

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" }, origin);
  }

  const conversationId = request.method === "GET"
    ? request.headers.get(CONVERSATION_HEADER) || "health-check"
    : request.headers.get(CONVERSATION_HEADER);
  if (!conversationId || !CONVERSATION_ID.test(conversationId)) {
    return jsonResponse(400, {
      error: `${CONVERSATION_HEADER} must be 6-36 URL-safe characters`,
    }, origin);
  }

  let target: URL;
  try {
    target = agentUrl(
      environment,
      request.url,
      request.method === "GET",
    );
  } catch {
    return jsonResponse(503, { error: "Agent upstream is not configured" }, origin);
  }
  let body: ArrayBuffer | undefined;
  let parsedBody: unknown;
  if (request.method === "POST") {
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_REQUEST_BYTES) {
      return jsonResponse(413, { error: "Agent request is too large" }, origin);
    }
    body = await request.arrayBuffer();
    if (body.byteLength > MAX_REQUEST_BYTES) {
      return jsonResponse(413, { error: "Agent request is too large" }, origin);
    }
    try {
      parsedBody = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return jsonResponse(400, { error: "Agent request must be valid JSON" }, origin);
    }
  }

  const headers = new Headers({ [CONVERSATION_HEADER]: conversationId });
  for (const name of ["authorization", "content-type", "accept"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  try {
    const serviceHeaders = await createAgentServiceSignatureHeaders({
      body: parsedBody,
      conversationId,
      environment,
      method: request.method,
    });
    serviceHeaders.forEach((value, name) => headers.set(name, value));
  } catch {
    return jsonResponse(
      503,
      { error: "Agent service authentication is not configured" },
      origin,
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      signal: request.signal,
      ...(request.method === "POST"
        ? { body }
        : {}),
    });
  } catch {
    return jsonResponse(502, { error: "Agent upstream unavailable" }, origin);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: copyUpstreamHeaders(upstream, origin),
  });
}
