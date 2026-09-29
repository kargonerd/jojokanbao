export const SIGNUP_CONFIG_KEY = "auth_signup_config";
export interface SignupConfig { invitationRequired: boolean }
export interface SignupPolicySync { refresh(): void; stop(): void }

export function parseSignupConfig(value: unknown): SignupConfig | undefined {
  if (!value || typeof value !== "object" || !("invitationRequired" in value)
    || typeof value.invitationRequired !== "boolean") return undefined;
  return { invitationRequired: value.invitationRequired };
}

// React Native ships the `abort-controller` polyfill, which has no
// AbortSignal.timeout, and Safari only gained it in 16.4. Build the deadline
// from AbortController so registration works on every client.
const SIGNUP_AUTHORIZATION_TIMEOUT_MS = 20_000;

/** The server authorizes each registration using its own PostHog snapshot. */
export async function authorizeSignup(url: string, email: string, invitationCode?: string): Promise<string> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), SIGNUP_AUTHORIZATION_TIMEOUT_MS);
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, invitationCode: invitationCode?.trim() || "" }),
      signal: controller.signal,
    });
  } catch {
    throw { code: "signup_service_unreachable" };
  } finally {
    clearTimeout(deadline);
  }
  // A missing deployment answers with an HTML error page, so an unparseable
  // body must surface as a service failure instead of a parse error.
  const result = await response.json().catch(() => null) as
    { authorization?: unknown; error?: { code?: string; message?: string } } | null;
  if (!response.ok || typeof result?.authorization !== "string") {
    throw {
      code: result?.error?.code,
      status: response.status,
      message: result?.error?.message ?? "注册服务暂时不可用，请稍后重试。",
    };
  }
  return result.authorization;
}
