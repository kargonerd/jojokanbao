import { create } from "zustand";
import { loadUnreadNotificationCount } from "./api";

interface NotificationState {
  userId: string | null;
  unreadCount: number;
  loading: boolean;
  setUnreadCount: (count: number) => void;
  adjustUnreadCount: (change: number) => void;
}

export const useNotificationStore = create<NotificationState>((set) => ({
  userId: null,
  unreadCount: 0,
  loading: false,
  setUnreadCount: (count) => set({ unreadCount: Math.max(0, count) }),
  adjustUnreadCount: (change) => set((state) => ({ unreadCount: Math.max(0, state.unreadCount + change) })),
}));

let requestId = 0;

export function resetNotifications(): void {
  requestId += 1;
  useNotificationStore.setState({ userId: null, unreadCount: 0, loading: false });
}

export async function refreshUnreadNotifications(userId: string): Promise<void> {
  const currentRequest = ++requestId;
  useNotificationStore.setState({ userId, loading: true });
  try {
    const unreadCount = await loadUnreadNotificationCount();
    if (currentRequest === requestId && useNotificationStore.getState().userId === userId) {
      useNotificationStore.setState({ unreadCount });
    }
  } finally {
    if (currentRequest === requestId) useNotificationStore.setState({ loading: false });
  }
}
