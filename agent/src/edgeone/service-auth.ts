import type { AgentEnvironment } from "../models";
import { AgentHttpError } from "./http-error";
import type { EdgeOneAgentContext } from "./types";

export const AGENT_SERVICE_AUTH_HEADERS = {
  timestamp: "X-JOJO-Service-Timestamp",
  nonce: "X-JOJO-Service-Nonce",
  signature: "X-JOJO-Service-Signature",
} as const;

const SIGNATURE_VERSION = "jojo-agent-service-v1";
const MAX_CLOCK_SKEW_SECONDS = 60;
const NONCE_PATTERN = /^[0-9A-Za-z_-]{22,64}$/;
const consumedNonces = new Map<string, number>();
const encoder = new TextEncoder();

export interface AgentServiceSignatureInput {
  body?: unknown;
  conversationId: string;
  environment: AgentEnvironment;
  method: string;
  nonce?: string;
  now?: number;
}

export interface AgentServiceAuthorizationOptions {
  body?: unknown;
  conversationId?: string;
  method?: string;
  now?: number;
}

function configuredSecret(environment: AgentEnvironment): string {
  const secret = environment.JOJO_AGENT_SERVICE_SECRET?.trim() ?? "";
  if (secret.length < 32) {
    throw new AgentHttpError(503, "Agent service authentication is not configured");
  }
  return secret;
}

function requestHeader(
  headers: EdgeOneAgentContext["request"]["headers"],
  name: string,
): string {
  if (headers instanceof Headers) return headers.get(name)?.trim() ?? "";
  if (!headers) return "";
  const normalized = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalized) return value?.trim() ?? "";
  }
  return "";
}

function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Request body is not valid JSON");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, item]) =>
      `${JSON.stringify(key)}:${canonicalJson(item)}`
    ).join(",")}}`;
  }
  throw new Error("Request body is not valid JSON");
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[0-9A-Za-z_-]+$/.test(value)) return undefined;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return undefined;
  }
}

async function bodyDigest(body: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(canonicalJson(body)),
  );
  return base64Url(new Uint8Array(digest));
}

async function signingPayload(input: {
  body: unknown;
  conversationId: string;
  method: string;
  nonce: string;
  timestamp: string;
}): Promise<Uint8Array<ArrayBuffer>> {
  return encoder.encode([
    SIGNATURE_VERSION,
    input.timestamp,
    input.nonce,
    input.method.toUpperCase(),
    input.conversationId,
    await bodyDigest(input.body),
  ].join("\n"));
}

async function hmacKey(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usage,
  );
}

function pruneAndConsumeNonce(nonce: string, nowSeconds: number): boolean {
  for (const [value, expiresAt] of consumedNonces) {
    if (expiresAt <= nowSeconds) consumedNonces.delete(value);
  }
  if (consumedNonces.has(nonce)) return false;
  consumedNonces.set(nonce, nowSeconds + MAX_CLOCK_SKEW_SECONDS * 2);
  return true;
}

export async function createAgentServiceSignatureHeaders(
  input: AgentServiceSignatureInput,
): Promise<Headers> {
  const secret = configuredSecret(input.environment);
  const timestamp = String(Math.floor((input.now ?? Date.now()) / 1_000));
  const nonce = input.nonce ?? crypto.randomUUID().replaceAll("-", "");
  if (!NONCE_PATTERN.test(nonce)) throw new Error("Agent service nonce is invalid");
  const payload = await signingPayload({
    body: input.body,
    conversationId: input.conversationId,
    method: input.method,
    nonce,
    timestamp,
  });
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, ["sign"]),
    payload,
  );
  return new Headers({
    [AGENT_SERVICE_AUTH_HEADERS.timestamp]: timestamp,
    [AGENT_SERVICE_AUTH_HEADERS.nonce]: nonce,
    [AGENT_SERVICE_AUTH_HEADERS.signature]: base64Url(
      new Uint8Array(signature),
    ),
  });
}

export async function authorizeAgentServiceRequest(
  context: EdgeOneAgentContext,
  options: AgentServiceAuthorizationOptions = {},
): Promise<void> {
  const environment = context.env ?? process.env;
  const secret = configuredSecret(environment);
  const timestamp = requestHeader(
    context.request.headers,
    AGENT_SERVICE_AUTH_HEADERS.timestamp,
  );
  const nonce = requestHeader(
    context.request.headers,
    AGENT_SERVICE_AUTH_HEADERS.nonce,
  );
  const encodedSignature = requestHeader(
    context.request.headers,
    AGENT_SERVICE_AUTH_HEADERS.signature,
  );
  const signature = fromBase64Url(encodedSignature);
  const timestampSeconds = Number(timestamp);
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1_000);
  const conversationId = options.conversationId
    ?? context.conversation_id
    ?? requestHeader(context.request.headers, "Makers-Conversation-Id");

  if (
    !Number.isInteger(timestampSeconds)
    || Math.abs(nowSeconds - timestampSeconds) > MAX_CLOCK_SKEW_SECONDS
    || !NONCE_PATTERN.test(nonce)
    || !signature
    || !conversationId
  ) {
    throw new AgentHttpError(401, "Trusted service authentication required");
  }

  const payload = await signingPayload({
    body: options.body ?? context.request.body,
    conversationId,
    method: options.method ?? context.request.method ?? "POST",
    nonce,
    timestamp,
  });
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, ["verify"]),
    signature,
    payload,
  );
  if (!valid || !pruneAndConsumeNonce(nonce, nowSeconds)) {
    throw new AgentHttpError(401, "Trusted service authentication required");
  }
}
