import {
  createAgentServiceSignatureHeaders,
} from "@jojo/agent/edgeone/service-auth";
import { evaluateAuthenticatedFeatureFlag } from "./feature-flag-evaluator";

const CONVERSATION_HEADER = "Makers-Conversation-Id";
const CONVERSATION_ID = /^[0-9A-Za-z._-]{6,36}$/;
const MAX_REQUEST_BYTES = 64 * 1024;
const SUPABASE_TIMEOUT_MS = 5_000;
const RAG_WORKSPACE_FLAG = "rag.workspace";

export interface AgentProxyContext {
  env?: Readonly<Record<string, string | undefined>>;
  request: Request;
}

function bearerToken(headers: Headers): string | undefined {
  const value = headers.get("authorization")?.trim();
  if (!value) return undefined;
  const [scheme, token] = value.split(/\s+/, 2);
  return scheme?.toLowerCase() === "bearer" && token ? token : undefined;
}

function supabaseSignal(request: Request): AbortSignal {
  return AbortSignal.any([
    request.signal,
    AbortSignal.timeout(SUPABASE_TIMEOUT_MS),
  ]);
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

async function requireRagWorkspaceAccess(
  environment: Readonly<Record<string, string | undefined>>,
  request: Request,
  origin: string | null,
): Promise<Response | null> {
  const baseUrl = environment.VITE_SUPABASE_URL?.trim().replace(/\/$/, "");
  const publishableKey = environment.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
  const operatorToken = environment.JOJO_OPERATOR_TOKEN?.trim();
  if (!baseUrl || !publishableKey || !operatorToken || operatorToken.length < 32) {
    return jsonResponse(
      503,
      { error: "Feature evaluation is not configured" },
      origin,
    );
  }

  const token = bearerToken(request.headers);
  if (!token) {
    return jsonResponse(401, { error: "Authentication required" }, origin);
  }

  let authResponse: Response;
  let configResponse: Response;
  try {
    const signal = supabaseSignal(request);
    [authResponse, configResponse] = await Promise.all([
      fetch(`${baseUrl}/auth/v1/user`, {
        method: "GET",
        headers: {
          apikey: publishableKey,
          authorization: `Bearer ${token}`,
          accept: "application/json",
        },
        signal,
      }),
      fetch(`${baseUrl}/rest/v1/rpc/operator_get_feature_flag`, {
        method: "POST",
        headers: {
          apikey: publishableKey,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          p_operator_token: operatorToken,
          p_key: RAG_WORKSPACE_FLAG,
        }),
        signal,
      }),
    ]);
  } catch {
    return jsonResponse(
      503,
      { error: "Feature evaluation service unavailable" },
      origin,
    );
  }

  if (authResponse.status === 401 || authResponse.status === 403) {
    return jsonResponse(401, { error: "Authentication required" }, origin);
  }
  if (!authResponse.ok) {
    return jsonResponse(
      503,
      { error: "Feature authentication service unavailable" },
      origin,
    );
  }
  if (!configResponse.ok) {
    return jsonResponse(
      503,
      { error: "Feature rule service unavailable" },
      origin,
    );
  }

  let authPayload: unknown;
  let configPayload: unknown;
  try {
    [authPayload, configPayload] = await Promise.all([
      authResponse.json(),
      configResponse.json(),
    ]);
  } catch {
    return jsonResponse(
      503,
      { error: "Feature evaluation response is invalid" },
      origin,
    );
  }
  const userId = authPayload
    && typeof authPayload === "object"
    && "id" in authPayload
    ? authPayload.id
    : undefined;
  if (typeof userId !== "string" || !userId) {
    return jsonResponse(
      503,
      { error: "Feature authentication response is invalid" },
      origin,
    );
  }

  try {
    const enabled = await evaluateAuthenticatedFeatureFlag(
      configPayload,
      RAG_WORKSPACE_FLAG,
      userId,
    );
    if (enabled) return null;
  } catch {
    return jsonResponse(
      503,
      { error: "Feature rule configuration is invalid" },
      origin,
    );
  }

  return jsonResponse(403, { error: "This feature is not available" }, origin);
}

function agentUrl(
  environment: Readonly<Record<string, string | undefined>>,
  requestUrl: string,
  health: boolean,
): URL {
  const configured = environment.JOJO_AGENT_UPSTREAM_URL?.trim();
  const incoming = new URL(requestUrl);
  const previewToken = incoming.searchParams.get("eo_token");
  const target = configured ? new URL(configured) : new URL(incoming);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("JOJO_AGENT_UPSTREAM_URL must use http or https");
  }
  if (!configured) target.pathname = "/jojo";
  target.pathname = health
    ? `${target.pathname.replace(/\/$/, "")}/health`
    : target.pathname.replace(/\/$/, "");
  target.search = "";
  if (previewToken) target.searchParams.set("eo_token", previewToken);
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
export async function handleAgentProxyRequest(
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

  if (request.method === "POST") {
    const denied = await requireRagWorkspaceAccess(environment, request, origin);
    if (denied) return denied;
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
