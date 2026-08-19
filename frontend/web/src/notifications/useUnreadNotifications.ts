import { useEffect } from "react";
import { useAccountSessionStore } from "../account/session";
import { refreshUnreadNotifications, resetNotifications, useNotificationStore } from "./store";

export function useUnreadNotifications() {
  const userId = useAccountSessionStore((state) => state.userId);
  const unreadCount = useNotificationStore((state) => state.unreadCount);

  useEffect(() => {
    if (!userId) {
      resetNotifications();
      return;
    }
    const refresh = () => { void refreshUnreadNotifications(userId).catch(() => undefined); };
    refresh();
    const interval = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
    };
  }, [userId]);

  return { userId, unreadCount };
}
