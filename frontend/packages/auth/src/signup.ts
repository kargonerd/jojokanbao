export const SIGNUP_CONFIG_KEY = "auth_signup_config";
export interface SignupConfig { invitationRequired: boolean }
export interface SignupPolicySync { refresh(): void; stop(): void }

export function parseSignupConfig(value: unknown): SignupConfig | undefined {
  if (!value || typeof value !== "object" || !("invitationRequired" in value)
    || typeof value.invitationRequired !== "boolean") return undefined;
  return { invitationRequired: value.invitationRequired };
}

/** The server authorizes each registration using its own PostHog snapshot. */
export async function authorizeSignup(url: string, email: string, invitationCode?: string): Promise<string> {
  const response = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, invitationCode: invitationCode?.trim() || "" }),
    signal: AbortSignal.timeout(12_000),
  });
  const result = await response.json();
  if (!response.ok || typeof result.authorization !== "string") {
    throw new Error(result.error?.message || "注册服务暂时不可用，请稍后重试。");
  }
  return result.authorization;
}
