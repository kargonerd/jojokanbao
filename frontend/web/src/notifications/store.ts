import { create } from "zustand";
import { loadUnreadNotificationCount } from "./api";

interface NotificationState {
  userId: string | null;
  unreadCount: number;
  loading: boolean;
  setUnreadCount: (count: number) => void;
  adjustUnreadCount: (change: number) => void;
}

let requestId = 0;
let countRevision = 0;
let lastRequestAt: number | null = null;
let inFlight: { userId: string; promise: Promise<void> } | null = null;

export const useNotificationStore = create<NotificationState>((set) => ({
  userId: null,
  unreadCount: 0,
  loading: false,
  setUnreadCount: (count) => {
    countRevision += 1;
    set({ unreadCount: Math.max(0, count) });
  },
  adjustUnreadCount: (change) => {
    countRevision += 1;
    set((state) => ({ unreadCount: Math.max(0, state.unreadCount + change) }));
  },
}));

export function resetNotifications(): void {
  requestId += 1;
  countRevision += 1;
  lastRequestAt = null;
  inFlight = null;
  useNotificationStore.setState({ userId: null, unreadCount: 0, loading: false });
}

export function unreadNotificationRefreshDelay(userId: string, intervalMs: number): number {
  if (useNotificationStore.getState().userId !== userId || lastRequestAt === null) return 0;
  return Math.max(0, lastRequestAt + intervalMs - Date.now());
}

export function refreshUnreadNotifications(userId: string, minIntervalMs = 0): Promise<void> {
  if (inFlight?.userId === userId) return inFlight.promise;
  if (unreadNotificationRefreshDelay(userId, minIntervalMs) > 0) return Promise.resolve();

  const currentRequest = ++requestId;
  const currentRevision = countRevision;
  lastRequestAt = Date.now();
  useNotificationStore.setState((state) => ({
    userId,
    unreadCount: state.userId === userId ? state.unreadCount : 0,
    loading: true,
  }));
  const promise = (async () => {
    try {
      const unreadCount = await loadUnreadNotificationCount();
      // A reply may have been marked read while this request was in flight.
      if (currentRequest === requestId && currentRevision === countRevision
        && useNotificationStore.getState().userId === userId) {
        useNotificationStore.setState({ unreadCount });
      }
    } finally {
      if (currentRequest === requestId) {
        inFlight = null;
        useNotificationStore.setState({ loading: false });
      }
    }
  })();
  inFlight = { userId, promise };
  return promise;
}
