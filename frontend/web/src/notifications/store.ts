import { create } from "zustand";
import { loadUnreadNotificationCount } from "./api";

interface NotificationState {
  userId: string | null;
  unreadCount: number;
  loading: boolean;
  refreshVersion: number;
  setUnreadCount: (count: number) => void;
  adjustUnreadCount: (change: number) => void;
}

let requestId = 0;
let countRevision = 0;
let lastRequestAt: number | null = null;
let inFlight: { userId: string; revision: number; promise: Promise<void> } | null = null;

export const useNotificationStore = create<NotificationState>((set) => ({
  userId: null,
  unreadCount: 0,
  loading: false,
  refreshVersion: 0,
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
  useNotificationStore.setState({ userId: null, unreadCount: 0, loading: false, refreshVersion: 0 });
}

export function unreadNotificationRefreshDelay(userId: string, intervalMs: number): number {
  if (useNotificationStore.getState().userId !== userId || lastRequestAt === null) return 0;
  return Math.max(0, lastRequestAt + intervalMs - Date.now());
}

export function refreshUnreadNotifications(userId: string, minIntervalMs = 0): Promise<void> {
  if (inFlight?.userId === userId) {
    // A mutation invalidates an older count response. An explicit refresh must
    // wait for that request and then obtain the remaining unread count.
    if (minIntervalMs === 0 && inFlight.revision !== countRevision) {
      return inFlight.promise.catch(() => undefined).then(() => {
        if (useNotificationStore.getState().userId === userId) return refreshUnreadNotifications(userId);
      });
    }
    return inFlight.promise;
  }
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
      if (currentRequest === requestId && useNotificationStore.getState().userId === userId) {
        useNotificationStore.setState((state) => ({
          ...(currentRevision === countRevision ? { unreadCount } : {}),
          // Inbox contents can change even when the unread count is unchanged.
          refreshVersion: state.refreshVersion + 1,
        }));
      }
    } finally {
      if (currentRequest === requestId) {
        inFlight = null;
        useNotificationStore.setState({ loading: false });
      }
    }
  })();
  inFlight = { userId, revision: currentRevision, promise };
  return promise;
}
