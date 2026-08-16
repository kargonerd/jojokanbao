import {
  createAgentServiceSignatureHeaders,
} from "@jojo/agent/edgeone/service-auth";
import { bearerToken } from "./auth";

const CONVERSATION_HEADER = "Makers-Conversation-Id";
const CONVERSATION_ID = /^[0-9A-Za-z._-]{6,36}$/;
const MAX_REQUEST_BYTES = 64 * 1024;
const AGENT_CHAT_FLAG = "agent.chat";

interface FeatureFlagRule {
  bucketBy?: unknown;
  bucketSalt?: unknown;
  conditionType?: unknown;
  enabled?: unknown;
  endsAt?: unknown;
  id?: unknown;
  percentage?: unknown;
  serve?: unknown;
  startsAt?: unknown;
  userIds?: unknown;
}

interface FeatureFlagConfig {
  key?: unknown;
  revision?: unknown;
  rules?: unknown;
}

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

function activeAt(rule: FeatureFlagRule, now: number): boolean {
  if (typeof rule.enabled !== "boolean") throw new Error("Invalid rule enabled");
  if (!rule.enabled) return false;

  for (const [boundary, comparison] of [
    [rule.startsAt, "start"],
    [rule.endsAt, "end"],
  ] as const) {
    if (boundary === null || boundary === undefined || boundary === "") continue;
    if (typeof boundary !== "string") throw new Error("Invalid rule window");
    const timestamp = Date.parse(boundary);
    if (!Number.isFinite(timestamp)) throw new Error("Invalid rule window");
    if (comparison === "start" && now < timestamp) return false;
    if (comparison === "end" && now >= timestamp) return false;
  }
  return true;
}

async function percentageMatches(
  rule: FeatureFlagRule,
  userId: string,
): Promise<boolean> {
  if (rule.bucketBy === "visitor") return false;
  if (
    rule.bucketBy !== "user"
    || typeof rule.id !== "string"
    || typeof rule.bucketSalt !== "string"
    || !Number.isInteger(rule.percentage)
    || Number(rule.percentage) < 1
    || Number(rule.percentage) > 100
  ) {
    throw new Error("Invalid percentage rule");
  }
  const source = [
    AGENT_CHAT_FLAG,
    rule.id,
    rule.bucketSalt,
    `user:${userId}`,
  ].join(":");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(source),
  );
  const bucket = new DataView(digest).getUint32(0, false) % 100;
  return bucket < Number(rule.percentage);
}

async function evaluateAgentChatFlag(
  payload: unknown,
  userId: string,
): Promise<boolean> {
  if (!payload || typeof payload !== "object") {
    throw new Error("Feature flag is missing");
  }
  const config = payload as FeatureFlagConfig;
  if (
    config.key !== AGENT_CHAT_FLAG
    || typeof config.revision !== "number"
    || !Array.isArray(config.rules)
    || config.rules.length === 0
  ) {
    throw new Error("Invalid feature flag config");
  }

  const now = Date.now();
  for (const value of config.rules) {
    if (!value || typeof value !== "object") throw new Error("Invalid rule");
    const rule = value as FeatureFlagRule;
    if (!activeAt(rule, now)) continue;
    if (typeof rule.serve !== "boolean") throw new Error("Invalid rule result");

    let matches = false;
    switch (rule.conditionType) {
      case "global":
      case "authenticated":
        matches = true;
        break;
      case "users":
        if (!Array.isArray(rule.userIds) || !rule.userIds.every((id) => typeof id === "string")) {
          throw new Error("Invalid users rule");
        }
        matches = rule.userIds.includes(userId);
        break;
      case "percentage":
        matches = await percentageMatches(rule, userId);
        break;
      default:
        throw new Error("Invalid rule condition");
    }
    if (matches) return rule.serve;
  }
  return false;
}

async function requireAgentChatAccess(
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
  try {
    authResponse = await fetch(`${baseUrl}/auth/v1/user`, {
      method: "GET",
      headers: {
        apikey: publishableKey,
        authorization: `Bearer ${token}`,
        accept: "application/json",
      },
      signal: request.signal,
    });
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
      { error: "Feature evaluation service unavailable" },
      origin,
    );
  }

  let authPayload: unknown;
  try {
    authPayload = await authResponse.json();
  } catch {
    return jsonResponse(
      503,
      { error: "Feature evaluation service unavailable" },
      origin,
    );
  }
  const userId = authPayload && typeof authPayload === "object" && "id" in authPayload
    ? authPayload.id
    : undefined;
  if (typeof userId !== "string" || !userId) {
    return jsonResponse(401, { error: "Authentication required" }, origin);
  }

  let configResponse: Response;
  try {
    configResponse = await fetch(`${baseUrl}/rest/v1/rpc/operator_get_feature_flag`, {
      method: "POST",
      headers: {
        apikey: publishableKey,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        p_operator_token: operatorToken,
        p_key: AGENT_CHAT_FLAG,
      }),
      signal: request.signal,
    });
  } catch {
    return jsonResponse(
      503,
      { error: "Feature evaluation service unavailable" },
      origin,
    );
  }
  if (!configResponse.ok) {
    return jsonResponse(
      503,
      { error: "Feature evaluation service unavailable" },
      origin,
    );
  }

  try {
    const enabled = await evaluateAgentChatFlag(await configResponse.json(), userId);
    if (enabled) return null;
  } catch {
    return jsonResponse(
      503,
      { error: "Feature evaluation service unavailable" },
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
  const target = new URL(incoming);
  if (configured) {
    const configuredUrl = new URL(configured);
    if (configuredUrl.protocol !== "http:" && configuredUrl.protocol !== "https:") {
      throw new Error("JOJO_AGENT_UPSTREAM_URL must use http or https");
    }
    target.pathname = configuredUrl.pathname;
  } else {
    target.pathname = "/jojo";
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("JOJO_AGENT_UPSTREAM_URL must use http or https");
  }
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

  if (request.method === "POST") {
    const denied = await requireAgentChatAccess(environment, request, origin);
    if (denied) return denied;
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
