import type { OfflineBookIdentity } from "./offline-books";

/** A local-only identity for already downloaded books; never use it to authorize network APIs. */
export function offlineIdentityFromStoredSession(current: OfflineBookIdentity, serialized: string | null, allowFallback: boolean): OfflineBookIdentity {
  if (current.userId || !allowFallback || !serialized) return current;
  try {
    const session = JSON.parse(serialized) as { user?: { id?: unknown } };
    const userId = session.user?.id;
    return typeof userId === "string" && userId.length > 0 && userId.length <= 128
      ? { initialized: true, userId }
      : current;
  } catch { return current; }
}
