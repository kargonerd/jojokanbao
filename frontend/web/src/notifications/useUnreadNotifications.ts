import { useEffect } from "react";
import { useAccountSessionStore } from "../account/session";
import {
  refreshUnreadNotifications,
  resetNotifications,
  unreadNotificationRefreshDelay,
  useNotificationStore,
} from "./store";

const POLL_INTERVAL_MS = 5 * 60_000;
const FOREGROUND_REFRESH_INTERVAL_MS = 30_000;

interface PollingSubscription {
  userId: string;
  subscribers: number;
  stop: () => void;
}

let polling: PollingSubscription | null = null;

function subscribeToUnreadNotifications(userId: string): () => void {
  if (polling?.userId !== userId) {
    polling?.stop();
    let stopped = false;
    let timer: number | undefined;
    const clearTimer = () => {
      window.clearTimeout(timer);
      timer = undefined;
    };
    const schedule = () => {
      clearTimer();
      if (stopped || document.visibilityState === "hidden") return;
      timer = window.setTimeout(() => refresh(POLL_INTERVAL_MS), Math.max(1, unreadNotificationRefreshDelay(userId, POLL_INTERVAL_MS)));
    };
    const refresh = (minIntervalMs: number) => {
      if (stopped || document.visibilityState === "hidden") return;
      clearTimer();
      void refreshUnreadNotifications(userId, minIntervalMs).catch(() => undefined).finally(schedule);
    };
    const onForeground = () => refresh(FOREGROUND_REFRESH_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") clearTimer();
      else onForeground();
    };
    polling = {
      userId,
      subscribers: 0,
      stop: () => {
        stopped = true;
        clearTimer();
        document.removeEventListener("visibilitychange", onVisibilityChange);
        window.removeEventListener("focus", onForeground);
      },
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onForeground);
    refresh(POLL_INTERVAL_MS);
  }

  // Account menus in different parts of the shell share one timer and listeners.
  const subscription = polling;
  subscription.subscribers += 1;
  return () => {
    subscription.subscribers -= 1;
    if (subscription.subscribers === 0) {
      subscription.stop();
      if (polling === subscription) polling = null;
    }
  };
}

export function useUnreadNotifications() {
  const userId = useAccountSessionStore((state) => state.userId);
  const unreadCount = useNotificationStore((state) => state.userId === userId ? state.unreadCount : 0);

  useEffect(() => {
    if (!userId) {
      resetNotifications();
      return;
    }
    return subscribeToUnreadNotifications(userId);
  }, [userId]);

  return { userId, unreadCount };
}
