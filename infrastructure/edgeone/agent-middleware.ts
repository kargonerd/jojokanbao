const SUPABASE_TIMEOUT_MS = 5_000;

type AgentMiddlewareContext = {
  env?: Readonly<Record<string, string | undefined>>;
  next: () => Response | Promise<Response>;
  request: Request;
};

function jsonResponse(status: number, error: string): Response {
  return Response.json({ error }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function bearerToken(headers: Headers): string | undefined {
  const value = headers.get("authorization")?.trim();
  if (!value) return undefined;
  const [scheme, token] = value.split(/\s+/, 2);
  return scheme?.toLowerCase() === "bearer" && token ? token : undefined;
}

function authenticationSignal(request: Request): AbortSignal {
  const timeout = AbortSignal.timeout(SUPABASE_TIMEOUT_MS);
  return request.signal
    ? AbortSignal.any([request.signal, timeout])
    : timeout;
}

export async function middleware(
  context: AgentMiddlewareContext,
): Promise<Response> {
  if (context.request.method !== "POST") {
    return jsonResponse(405, "Method not allowed");
  }

  const environment = context.env ?? {};
  const baseUrl = environment.VITE_SUPABASE_URL?.trim().replace(/\/$/, "");
  const publishableKey = environment.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!baseUrl || !publishableKey) {
    return jsonResponse(503, "JOJO authentication is not configured");
  }

  const token = bearerToken(context.request.headers);
  if (!token) return jsonResponse(401, "Authentication required");

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/auth/v1/user`, {
      headers: {
        accept: "application/json",
        apikey: publishableKey,
        authorization: `Bearer ${token}`,
      },
      signal: authenticationSignal(context.request),
    });
  } catch {
    return jsonResponse(503, "Authentication service unavailable");
  }

  if ([400, 401, 403].includes(response.status)) {
    return jsonResponse(401, "Invalid or expired access token");
  }
  if (!response.ok) {
    return jsonResponse(503, "Authentication service unavailable");
  }

  let user: unknown;
  try {
    user = await response.json();
  } catch {
    return jsonResponse(503, "Authentication service returned invalid data");
  }
  if (
    !user
    || typeof user !== "object"
    || !("id" in user)
    || typeof user.id !== "string"
    || !user.id
  ) {
    return jsonResponse(503, "Authentication service returned invalid data");
  }

  // Internal continuation preserves the Agent's ReadableStream; there is no
  // nested Cloud Function fetch and therefore no response buffering layer.
  return context.next();
}

export const config = {
  matcher: "/rag",
};
