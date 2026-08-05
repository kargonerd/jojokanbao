import type {
  AuthorizedAgentUser,
  EdgeOneAgentContext,
} from "./types";

export class AgentHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AgentHttpError";
  }
}

function bearerToken(
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
  const payload = await response.json() as { id?: unknown };
  if (typeof payload.id !== "string" || !payload.id) {
    throw new AgentHttpError(503, "Authentication service returned invalid data");
  }
  return { id: payload.id };
}
