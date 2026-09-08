import { useEffect, useRef, useState } from "react";
import { useAccountSessionStore } from "../account/session";
import { loadNotifications, markNotificationRead, markNotificationsRead } from "./api";
import { refreshUnreadNotifications, useNotificationStore } from "./store";
import type { UserNotification } from "./types";
import { useUnreadNotifications } from "./useUnreadNotifications";

const PAGE_SIZE = 50;
const READ_BATCH_SIZE = 100;

interface InboxSession {
  userId: string;
  headVersion: number;
  hasMore: boolean;
  busy: boolean;
  loaded: boolean;
  needsRefresh: boolean;
  headRequest: Promise<void> | null;
  readOverrides: Map<string, string>;
  pendingReadIds: Set<string>;
  listError: string | null;
}

function olderThan(item: UserNotification, boundary: UserNotification): boolean {
  return item.createdAt < boundary.createdAt || (item.createdAt === boundary.createdAt && item.id < boundary.id);
}

export function useNotificationInbox() {
  const { userId, unreadCount } = useUnreadNotifications();
  const [items, setItems] = useState<UserNotification[]>([]);
  const [loading, setLoading] = useState(Boolean(userId));
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");
  const itemsRef = useRef<UserNotification[]>([]);
  const sessionRef = useRef<InboxSession | null>(null);

  function updateItems(update: (current: UserNotification[]) => UserNotification[]) {
    itemsRef.current = update(itemsRef.current);
    setItems(itemsRef.current);
  }

  function applyReadOverrides(session: InboxSession, loaded: UserNotification[]) {
    return loaded.map((item) => {
      const readAt = session.readOverrides.get(item.id);
      return readAt && !item.readAt ? { ...item, readAt } : item;
    });
  }

  useEffect(() => {
    updateItems(() => []);
    setLoading(Boolean(userId));
    setRefreshing(false);
    setBusy(false);
    setHasMore(false);
    setError("");
    if (!userId) return;
    const session: InboxSession = { userId, headVersion: 0, hasMore: false, busy: false, loaded: false, needsRefresh: false, headRequest: null, readOverrides: new Map(), pendingReadIds: new Set(), listError: null };
    sessionRef.current = session;
    const active = () => sessionRef.current === session;

    const refreshList = (): Promise<void> => {
      if (!active()) return Promise.resolve();
      if (document.visibilityState === "hidden") {
        session.needsRefresh = true;
        return Promise.resolve();
      }
      if (session.headRequest) {
        session.needsRefresh = true;
        return session.headRequest;
      }
      session.needsRefresh = false;
      session.headVersion += 1;
      setRefreshing(true);
      const request = (async () => {
        try {
          const loaded = applyReadOverrides(session, await loadNotifications());
          if (!active()) return;
          const current = itemsRef.current;
          const boundary = loaded.at(-1);
          // Preserve older pages when the refreshed head overlaps our window.
          // A burst larger than one page resets the window to avoid a hidden gap.
          const overlaps = loaded.some((item) => current.some((entry) => entry.id === item.id));
          const older = loaded.length === PAGE_SIZE && overlaps && boundary ? current.filter((item) => olderThan(item, boundary)) : [];
          session.hasMore = older.length ? session.hasMore : loaded.length === PAGE_SIZE;
          updateItems(() => [...loaded, ...older]);
          session.loaded = true;
          setHasMore(session.hasMore);
          if (session.listError) {
            const previousError = session.listError;
            setError((currentError) => currentError === previousError ? "" : currentError);
            session.listError = null;
          }
        } catch (reason) {
          if (active()) {
            session.listError = reason instanceof Error ? reason.message : String(reason);
            setError(session.listError);
          }
        } finally {
          if (active()) {
            session.headRequest = null;
            setLoading(false);
            setRefreshing(false);
            if (session.needsRefresh && document.visibilityState !== "hidden") void refreshList();
          }
        }
      })();
      session.headRequest = request;
      return request;
    };

    let observedRefresh = false;
    const unsubscribe = useNotificationStore.subscribe((state, previous) => {
      if (state.userId === userId && state.refreshVersion !== previous.refreshVersion) {
        observedRefresh = true;
        void refreshList();
      }
    });
    const onVisibility = () => {
      // The shared visibility listener may have just started the count read;
      // its completion will refresh this list without a duplicate request.
      if (document.visibilityState !== "hidden" && (!session.loaded || session.needsRefresh)
        && !useNotificationStore.getState().loading) void refreshList();
    };
    document.addEventListener("visibilitychange", onVisibility);
    if (document.visibilityState !== "hidden") {
      // Share the shell's count request. The completion event loads the list;
      // fall back to a list read when the count endpoint is unavailable.
      void refreshUnreadNotifications(userId).catch(() => undefined).then(() => {
        if (!observedRefresh && active()) void refreshList();
      });
    }
    return () => {
      sessionRef.current = null;
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [userId]);

  async function loadMore() {
    const session = sessionRef.current;
    const lastItem = itemsRef.current.at(-1);
    if (!session || !lastItem || session.busy || session.headRequest) return;
    const headVersion = session.headVersion;
    session.busy = true;
    setBusy(true);
    setError("");
    try {
      const loaded = await loadNotifications(PAGE_SIZE, { id: lastItem.id, createdAt: lastItem.createdAt });
      if (sessionRef.current !== session || headVersion !== session.headVersion) return;
      updateItems((current) => [...current, ...applyReadOverrides(session, loaded).filter((item) => !current.some((entry) => entry.id === item.id))]);
      session.hasMore = loaded.length === PAGE_SIZE;
      setHasMore(session.hasMore);
    } catch (reason) {
      if (sessionRef.current === session && headVersion === session.headVersion) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (sessionRef.current === session) { session.busy = false; setBusy(false); }
    }
  }

  async function markPageRead() {
    const session = sessionRef.current;
    const ids = itemsRef.current.filter((item) => !item.readAt).map((item) => item.id);
    if (!session || session.busy || ids.length === 0) return;
    session.busy = true;
    for (const id of ids) session.pendingReadIds.add(id);
    setBusy(true);
    setError("");
    try {
      for (let offset = 0; offset < ids.length; offset += READ_BATCH_SIZE) {
        const batch = ids.slice(offset, offset + READ_BATCH_SIZE);
        const changed = await markNotificationsRead(batch);
        if (useAccountSessionStore.getState().userId !== session.userId) return;
        const now = new Date().toISOString();
        for (const id of batch) session.readOverrides.set(id, now);
        if (sessionRef.current === session) updateItems((current) => applyReadOverrides(session, current));
        if (useNotificationStore.getState().userId === session.userId) useNotificationStore.getState().adjustUnreadCount(-changed);
      }
    } catch (reason) {
      if (sessionRef.current === session) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      session.pendingReadIds.clear();
      session.busy = false;
      if (sessionRef.current === session) setBusy(false);
      if (useAccountSessionStore.getState().userId === session.userId && document.visibilityState !== "hidden") void refreshUnreadNotifications(session.userId).catch(() => undefined);
    }
  }

  function markOneRead(item: UserNotification) {
    const session = sessionRef.current;
    if (!session || item.readAt || session.readOverrides.has(item.id) || session.pendingReadIds.has(item.id)) return;
    const now = new Date().toISOString();
    session.readOverrides.set(item.id, now);
    updateItems((current) => applyReadOverrides(session, current));
    const optimisticChange = Math.min(1, useNotificationStore.getState().unreadCount);
    useNotificationStore.getState().adjustUnreadCount(-optimisticChange);
    void markNotificationRead(item.id).then((changed) => {
      if (changed === 0 && useAccountSessionStore.getState().userId === session.userId) useNotificationStore.getState().adjustUnreadCount(optimisticChange);
    }).catch((reason) => {
      session.readOverrides.delete(item.id);
      if (sessionRef.current === session) {
        updateItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, readAt: null } : entry));
        setError(reason instanceof Error ? reason.message : String(reason));
      }
      if (useAccountSessionStore.getState().userId === session.userId) useNotificationStore.getState().adjustUnreadCount(optimisticChange);
    }).finally(() => {
      if (useAccountSessionStore.getState().userId === session.userId && document.visibilityState !== "hidden") void refreshUnreadNotifications(session.userId).catch(() => undefined);
    });
  }

  return { userId, unreadCount, items, loading, refreshing, busy, hasMore, error, loadMore, markPageRead, markOneRead };
}
