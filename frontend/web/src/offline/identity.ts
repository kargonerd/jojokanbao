import { offlineIdentityFromStoredSession, type OfflineBookIdentity } from "@jojo/content";
import { useAccountSessionStore } from "../account/session";
import { supportsOfflineBooks } from "./platform";

export function browserOfflineBookIdentity(): OfflineBookIdentity {
  const current = useAccountSessionStore.getState();
  if (!supportsOfflineBooks() || current.userId) return current;
  try { return offlineIdentityFromStoredSession(current, localStorage.getItem("jojo-auth-session"), true); }
  catch { return current; }
}
