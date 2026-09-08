import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAccountSessionStore } from "../src/account/session";
import { refreshUnreadNotifications, resetNotifications, useNotificationStore } from "../src/notifications/store";
import type { UserNotification } from "../src/notifications/types";
import { useNotificationInbox } from "../src/notifications/useNotificationInbox";
import { useUnreadNotifications } from "../src/notifications/useUnreadNotifications";

const api = vi.hoisted(() => ({ loadNotifications: vi.fn(), loadUnreadNotificationCount: vi.fn(), markNotificationRead: vi.fn(), markNotificationsRead: vi.fn() }));
vi.mock("../src/notifications/api", () => api);
let visibility: DocumentVisibilityState;

function notification(index: number): UserNotification {
  return { id: `notification-${index}`, kind: "annotation.reply", title: `回复 ${index}`, body: null, targetPath: "/library", resourceType: null, resourceId: null, payload: {}, actorId: null, actorName: "读者", readAt: null, createdAt: new Date(Date.parse("2026-09-08T00:00:00Z") - index * 60_000).toISOString() };
}
const page = (start: number, count = 50) => Array.from({ length: count }, (_, index) => notification(start + index));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function settle() { await act(async () => { await Promise.resolve(); }); }
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function visible(state: DocumentVisibilityState, focus = false) {
  await act(async () => {
    visibility = state;
    document.dispatchEvent(new Event("visibilitychange"));
    if (focus) window.dispatchEvent(new Event("focus"));
  });
}
async function refresh() { await act(async () => { await refreshUnreadNotifications("reader-1"); }); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-08T00:00:00Z"));
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  resetNotifications();
  useAccountSessionStore.setState({ initialized: true, userId: "reader-1", displayName: "读者" });
  api.loadNotifications.mockReset().mockResolvedValue([notification(1), notification(2)]);
  api.loadUnreadNotificationCount.mockReset().mockResolvedValue(2);
  api.markNotificationRead.mockReset().mockResolvedValue(1);
  api.markNotificationsRead.mockReset().mockResolvedValue(2);
});
afterEach(() => { cleanup(); resetNotifications(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("live inbox using the shared foreground refresh", () => {
  it("refreshes list contents even if the count is unchanged, without another timer or queries outside the inbox", async () => {
    const menu = renderHook(useUnreadNotifications);
    const inbox = renderHook(useNotificationInbox);
    await settle();
    expect(api.loadUnreadNotificationCount).toHaveBeenCalledTimes(1);
    expect(api.loadNotifications).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    api.loadNotifications.mockResolvedValue([notification(0), { ...notification(1), readAt: "2026-09-08T00:01:00Z" }, notification(2)]);
    await advance(300_000);
    expect(inbox.result.current.unreadCount).toBe(2);
    expect(inbox.result.current.items.map((item) => item.id)).toEqual(["notification-0", "notification-1", "notification-2"]);
    expect(api.loadNotifications).toHaveBeenCalledTimes(2);
    inbox.unmount();
    await advance(300_000);
    expect(api.loadUnreadNotificationCount).toHaveBeenCalledTimes(3);
    expect(api.loadNotifications).toHaveBeenCalledTimes(2);
    menu.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("pauses both count and list in the background and deduplicates foreground/focus refreshes", async () => {
    renderHook(useNotificationInbox);
    await settle();
    await visible("hidden");
    await advance(3_600_000);
    expect(api.loadUnreadNotificationCount).toHaveBeenCalledTimes(1);
    expect(api.loadNotifications).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await visible("visible", true);
    expect(api.loadUnreadNotificationCount).toHaveBeenCalledTimes(2);
    expect(api.loadNotifications).toHaveBeenCalledTimes(2);
    await visible("hidden");
    await advance(10_000);
    await visible("visible", true);
    expect(api.loadNotifications).toHaveBeenCalledTimes(2);
  });

  it("does not query an initially hidden inbox and loads once when it becomes visible", async () => {
    visibility = "hidden";
    renderHook(useNotificationInbox);
    await advance(600_000);
    expect(api.loadUnreadNotificationCount).not.toHaveBeenCalled();
    expect(api.loadNotifications).not.toHaveBeenCalled();
    await visible("visible", true);
    expect(api.loadUnreadNotificationCount).toHaveBeenCalledTimes(1);
    expect(api.loadNotifications).toHaveBeenCalledTimes(1);
  });

  it("does one list read on returning after an older count request completed while hidden", async () => {
    renderHook(useNotificationInbox);
    await settle();
    const oldCount = deferred<number>();
    api.loadUnreadNotificationCount.mockReturnValueOnce(oldCount.promise);
    await advance(300_000);
    await visible("hidden");
    await act(async () => { oldCount.resolve(3); });
    expect(api.loadNotifications).toHaveBeenCalledTimes(1);
    await advance(30_001);
    await visible("visible", true);
    expect(api.loadUnreadNotificationCount).toHaveBeenCalledTimes(3);
    expect(api.loadNotifications).toHaveBeenCalledTimes(2);
  });

  it("preserves loaded older pages while merging a fresh head, and discards pagination started before a head refresh", async () => {
    api.loadNotifications.mockResolvedValueOnce(page(0));
    const inbox = renderHook(useNotificationInbox);
    await settle();
    api.loadNotifications.mockResolvedValueOnce(page(50));
    await act(async () => { await inbox.result.current.loadMore(); });
    const pagination = deferred<UserNotification[]>();
    api.loadNotifications.mockReturnValueOnce(pagination.promise);
    let more!: Promise<void>;
    act(() => { more = inbox.result.current.loadMore(); });
    api.loadNotifications.mockResolvedValueOnce(page(-1));
    await refresh();
    expect(inbox.result.current.items).toHaveLength(101);
    expect(inbox.result.current.items[0]?.id).toBe("notification--1");
    expect(inbox.result.current.items.at(-1)?.id).toBe("notification-99");
    await act(async () => { pagination.resolve(page(100)); await more; });
    expect(inbox.result.current.items).toHaveLength(101);
    expect(inbox.result.current.busy).toBe(false);
  });

  it("resets a nonoverlapping refreshed window so a large burst cannot leave an unpageable gap", async () => {
    api.loadNotifications.mockResolvedValueOnce(page(100));
    const inbox = renderHook(useNotificationInbox);
    await settle();
    api.loadNotifications.mockResolvedValueOnce(page(0));
    await refresh();
    expect(inbox.result.current.items).toHaveLength(50);
    expect(inbox.result.current.items.at(-1)?.id).toBe("notification-49");
    expect(inbox.result.current.hasMore).toBe(true);
    api.loadNotifications.mockResolvedValueOnce(page(50));
    await act(async () => { await inbox.result.current.loadMore(); });
    expect(api.loadNotifications).toHaveBeenLastCalledWith(50, { id: "notification-49", createdAt: notification(49).createdAt });
  });

  it("discards an old account's pending list and read responses", async () => {
    const oldList = deferred<UserNotification[]>();
    api.loadNotifications.mockReturnValueOnce(oldList.promise);
    const inbox = renderHook(useNotificationInbox);
    await settle();
    api.loadNotifications.mockResolvedValue([notification(100)]);
    api.loadUnreadNotificationCount.mockResolvedValue(1);
    await act(async () => { useAccountSessionStore.setState({ userId: "reader-2" }); });
    await act(async () => { oldList.resolve([notification(1)]); });
    expect(inbox.result.current.items.map((item) => item.id)).toEqual(["notification-100"]);
    const mark = deferred<number>();
    api.markNotificationsRead.mockReturnValueOnce(mark.promise);
    let marking!: Promise<void>;
    act(() => { marking = inbox.result.current.markPageRead(); });
    await act(async () => { useAccountSessionStore.setState({ userId: "reader-3" }); });
    await act(async () => { mark.resolve(1); await marking; });
    expect(inbox.result.current.unreadCount).toBe(1);
    expect(inbox.result.current.items[0]?.readAt).toBeNull();
  });

  it("marks only the displayed snapshot and leaves a message arriving during the write unread", async () => {
    const inbox = renderHook(useNotificationInbox);
    await settle();
    const mark = deferred<number>();
    api.markNotificationsRead.mockReturnValueOnce(mark.promise);
    let marking!: Promise<void>;
    act(() => { marking = inbox.result.current.markPageRead(); });
    api.loadNotifications.mockResolvedValue([notification(0), notification(1), notification(2)]);
    api.loadUnreadNotificationCount.mockResolvedValue(3);
    await refresh();
    expect(inbox.result.current.items).toHaveLength(3);
    api.loadUnreadNotificationCount.mockResolvedValue(1);
    await act(async () => { mark.resolve(2); await marking; });
    expect(api.markNotificationsRead).toHaveBeenCalledExactlyOnceWith(["notification-1", "notification-2"]);
    expect(api.markNotificationRead).not.toHaveBeenCalled();
    expect(inbox.result.current.items.filter((item) => !item.readAt).map((item) => item.id)).toEqual(["notification-0"]);
    expect(inbox.result.current.unreadCount).toBe(1);
  });

  it("does not let an older head response undo a successful read", async () => {
    const inbox = renderHook(useNotificationInbox);
    await settle();
    const stale = deferred<UserNotification[]>();
    api.loadNotifications.mockReturnValueOnce(stale.promise);
    await refresh();
    api.loadUnreadNotificationCount.mockResolvedValue(0);
    await act(async () => { await inbox.result.current.markPageRead(); });
    await act(async () => { stale.resolve([notification(1), notification(2)]); });
    expect(inbox.result.current.items.every((item) => item.readAt)).toBe(true);
    expect(inbox.result.current.unreadCount).toBe(0);
  });

  it("does not send a single-item write for a notification already in a pending batch", async () => {
    const inbox = renderHook(useNotificationInbox);
    await settle();
    const mark = deferred<number>();
    api.markNotificationsRead.mockReturnValueOnce(mark.promise);
    let marking!: Promise<void>;
    act(() => { marking = inbox.result.current.markPageRead(); });
    act(() => { inbox.result.current.markOneRead(notification(1)); });
    expect(api.markNotificationRead).not.toHaveBeenCalled();
    api.loadUnreadNotificationCount.mockResolvedValue(0);
    await act(async () => { mark.resolve(2); await marking; });
    expect(inbox.result.current.items.every((item) => item.readAt)).toBe(true);
  });

  it("excludes an optimistic single read from the batch and rolls back only that failed single read", async () => {
    const inbox = renderHook(useNotificationInbox);
    await settle();
    const single = deferred<number>();
    api.markNotificationRead.mockReturnValueOnce(single.promise);
    act(() => { inbox.result.current.markOneRead(notification(1)); });
    api.markNotificationsRead.mockResolvedValueOnce(1);
    api.loadUnreadNotificationCount.mockResolvedValue(1);
    await act(async () => { await inbox.result.current.markPageRead(); });
    expect(api.markNotificationsRead).toHaveBeenCalledExactlyOnceWith(["notification-2"]);
    await act(async () => { single.reject(new Error("单条更新失败")); });
    expect(inbox.result.current.items.filter((item) => !item.readAt).map((item) => item.id)).toEqual(["notification-1"]);
    expect(inbox.result.current.unreadCount).toBe(1);
  });

  it("reconciles the count when the server says a single notification was already read", async () => {
    const inbox = renderHook(useNotificationInbox);
    await settle();
    api.markNotificationRead.mockResolvedValueOnce(0);
    api.loadUnreadNotificationCount.mockResolvedValueOnce(2);
    await act(async () => { inbox.result.current.markOneRead(notification(1)); });
    expect(inbox.result.current.unreadCount).toBe(2);
    expect(api.loadUnreadNotificationCount).toHaveBeenCalledTimes(2);
    expect(inbox.result.current.items.find((item) => item.id === "notification-1")?.readAt).toBeTruthy();
  });

  it("clears a recovered list-read error without requiring the user to reopen the inbox", async () => {
    api.loadNotifications.mockRejectedValueOnce(new Error("列表暂时无法读取"));
    const inbox = renderHook(useNotificationInbox);
    await settle();
    expect(inbox.result.current.error).toBe("列表暂时无法读取");
    await advance(300_000);
    expect(inbox.result.current.items).toHaveLength(2);
    expect(inbox.result.current.error).toBe("");
  });

  it("commits successful batches and keeps the failed remainder unread when more than 100 items are displayed", async () => {
    api.loadNotifications.mockResolvedValueOnce(page(0));
    api.loadUnreadNotificationCount.mockResolvedValue(101);
    const inbox = renderHook(useNotificationInbox);
    await settle();
    api.loadNotifications.mockResolvedValueOnce(page(50));
    await act(async () => { await inbox.result.current.loadMore(); });
    api.loadNotifications.mockResolvedValueOnce(page(100, 1));
    await act(async () => { await inbox.result.current.loadMore(); });
    api.markNotificationsRead.mockResolvedValueOnce(100).mockRejectedValueOnce(new Error("第二批暂时失败"));
    api.loadUnreadNotificationCount.mockResolvedValue(1);
    api.loadNotifications.mockResolvedValue(page(0));
    await act(async () => { await inbox.result.current.markPageRead(); });
    expect(api.markNotificationsRead.mock.calls.map(([ids]) => ids.length)).toEqual([100, 1]);
    expect(inbox.result.current.items.filter((item) => !item.readAt).map((item) => item.id)).toEqual(["notification-100"]);
    expect(inbox.result.current.error).toBe("第二批暂时失败");
    expect(inbox.result.current.unreadCount).toBe(1);
    api.markNotificationsRead.mockResolvedValueOnce(1);
    api.loadUnreadNotificationCount.mockResolvedValue(0);
    await act(async () => { await inbox.result.current.markPageRead(); });
    expect(api.markNotificationsRead).toHaveBeenLastCalledWith(["notification-100"]);
  });
});
