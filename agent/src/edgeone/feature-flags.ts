import { AgentHttpError, bearerToken } from "./auth";
import type { AuthorizedAgentUser, EdgeOneAgentContext } from "./types";

export async function requireFeatureFlag(
  context: EdgeOneAgentContext,
  _user: AuthorizedAgentUser,
  key: string,
): Promise<void> {
  const environment = context.env ?? process.env;
  const baseUrl = environment.VITE_SUPABASE_URL?.trim().replace(/\/$/, "");
  const publishableKey = environment.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
  const token = bearerToken(context.request.headers);
  if (!baseUrl || !publishableKey) {
    throw new AgentHttpError(503, "Feature evaluation is not configured");
  }
  if (!token) throw new AgentHttpError(401, "Authentication required");

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/rest/v1/rpc/get_my_feature_flags`, {
      method: "POST",
      headers: {
        apikey: publishableKey,
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ p_keys: [key], p_visitor_id: null }),
      signal: context.request.signal,
    });
  } catch {
    throw new AgentHttpError(503, "Feature evaluation service unavailable");
  }
  if (!response.ok) {
    throw new AgentHttpError(503, "Feature evaluation service unavailable");
  }
  const payload = await response.json() as Array<{ flag_key?: unknown; enabled?: unknown }>;
  const decision = Array.isArray(payload)
    ? payload.find((item) => item.flag_key === key)
    : undefined;
  if (decision?.enabled !== true) {
    throw new AgentHttpError(403, "This feature is not available");
  }
}
