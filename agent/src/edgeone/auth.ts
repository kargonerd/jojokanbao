import type {
  AuthorizedAgentUser,
  EdgeOneAgentContext,
} from "./types";

const JWT_LEEWAY_SECONDS = 30;

type AppMetadata = { account_purpose?: unknown; jojo_roles?: unknown };

export class AgentHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "AgentHttpError";
  }
}

function base64UrlBytes(segment: string): Uint8Array {
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function userFromClaims(id: string, appMetadata: AppMetadata): AuthorizedAgentUser {
  // Only administrators can set app_metadata. User-editable metadata and
  // conversation ID prefixes must never grant access to network diagnostics.
  return {
    id,
    ...(Array.isArray(appMetadata.jojo_roles) && appMetadata.jojo_roles.includes("admin")
      ? { isAdmin: true } : {}),
    ...(appMetadata.account_purpose === "ai_availability_monitor"
      ? { isAvailabilityMonitor: true } : {}),
  };
}

export async function verifySupabaseAccessToken(
  token: string,
  secret: string,
  baseUrl: string,
): Promise<AuthorizedAgentUser | null> {
  const [head, body, signature] = token.split(".");
  if (!head || !body || !signature) return null;
  let header: { alg?: unknown };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlBytes(head)));
    claims = JSON.parse(new TextDecoder().decode(base64UrlBytes(body)));
  } catch {
    return null;
  }
  if (header?.alg !== "HS256") return null;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    asArrayBuffer(encoder.encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signingInput = asArrayBuffer(encoder.encode(`${head}.${body}`));
  const signatureValid = await crypto.subtle.verify("HMAC", key, asArrayBuffer(base64UrlBytes(signature)), signingInput);
  if (!signatureValid) return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp + JWT_LEEWAY_SECONDS < now) return null;
  if (typeof claims.nbf === "number" && claims.nbf - JWT_LEEWAY_SECONDS > now) return null;
  if (claims.aud !== "authenticated" || claims.iss !== `${baseUrl}/auth/v1`) return null;
  if (typeof claims.sub !== "string" || !claims.sub) return null;
  const appMetadata = claims.app_metadata && typeof claims.app_metadata === "object"
    ? claims.app_metadata as AppMetadata
    : {};
  return userFromClaims(claims.sub, appMetadata);
}

export function bearerToken(
  headers: EdgeOneAgentContext["request"]["headers"],
): string | undefined {
  const rawValue = headers instanceof Headers
    ? headers.get("authorization")
    : headers?.authorization ?? headers?.Authorization;
  const value = rawValue?.trim();
  if (!value) return undefined;
  const [scheme, token] = value.split(/\s+/, 2);
  return scheme?.toLowerCase() === "bearer" && token ? token : undefined;
}

function authenticationSignal(context: EdgeOneAgentContext): AbortSignal {
  const environment = context.env ?? process.env;
  const configuredSeconds = Number(environment.JOJO_AUTH_TIMEOUT_SECONDS ?? "5");
  const timeoutSeconds = Number.isFinite(configuredSeconds) && configuredSeconds > 0
    ? configuredSeconds
    : 5;
  const timeout = AbortSignal.timeout(timeoutSeconds * 1_000);
  return context.request.signal
    ? AbortSignal.any([context.request.signal, timeout])
    : timeout;
}

export async function authorizeSupabaseUser(
  context: EdgeOneAgentContext,
): Promise<AuthorizedAgentUser> {
  const environment = context.env ?? process.env;
  const baseUrl = environment.VITE_SUPABASE_URL?.trim().replace(/\/$/, "");
  const publishableKey = environment.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!baseUrl || !publishableKey) {
    throw new AgentHttpError(503, "JOJO authentication is not configured");
  }

  const token = bearerToken(context.request.headers);
  if (!token) throw new AgentHttpError(401, "Authentication required");

  const jwtSecret = environment.SUPABASE_JWT_SECRET?.trim();
  if (jwtSecret) {
    const user = await verifySupabaseAccessToken(token, jwtSecret, baseUrl);
    if (!user) throw new AgentHttpError(401, "Invalid or expired access token");
    return user;
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/auth/v1/user`, {
      headers: {
        apikey: publishableKey,
        authorization: `Bearer ${token}`,
        accept: "application/json",
      },
      signal: authenticationSignal(context),
    });
  } catch {
    throw new AgentHttpError(503, "Authentication service unavailable");
  }

  if (response.status === 400 || response.status === 401 || response.status === 403) {
    throw new AgentHttpError(401, "Invalid or expired access token");
  }
  if (!response.ok) {
    throw new AgentHttpError(503, "Authentication service unavailable");
  }
  const payload = await response.json() as {
    id?: unknown;
    app_metadata?: AppMetadata;
  };
  if (typeof payload.id !== "string" || !payload.id) {
    throw new AgentHttpError(503, "Authentication service returned invalid data");
  }
  return userFromClaims(payload.id, payload.app_metadata ?? {});
}
