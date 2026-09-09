import type { AuthState } from "@jojo/auth";

export const MOBILE_AUTH_STORAGE_KEY = "jojo-mobile-auth-session";

export async function readMobilePersistedSession(storage: { getItem: (key: string) => Promise<string | null> }): Promise<AuthState["session"]> {
  try {
    const raw = await storage.getItem(MOBILE_AUTH_STORAGE_KEY);
    const session = raw ? JSON.parse(raw) as AuthState["session"] : null;
    return session && typeof session.user?.id === "string" && session.user.id
      && typeof session.access_token === "string" && session.access_token
      && typeof session.refresh_token === "string" && session.refresh_token
      ? session : null;
  } catch { return null; }
}
