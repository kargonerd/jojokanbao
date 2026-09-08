import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAccountSessionStore } from "../src/account/session";
import { refreshUnreadNotifications, resetNotifications, useNotificationStore } from "../src/notifications/store";
import { useUnreadNotifications } from "../src/notifications/useUnreadNotifications";

const api = vi.hoisted(() => ({ loadUnreadNotificationCount: vi.fn() }));
vi.mock("../src/notifications/api", () => api);

let visibility: DocumentVisibilityState;

async function settle() {
  await act(async () => { await Promise.resolve(); });
}

async function advance(milliseconds: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
}

async function setVisibility(state: DocumentVisibilityState, focus = false) {
  await act(async () => {
    visibility = state;
    document.dispatchEvent(new Event("visibilitychange"));
    if (focus) window.dispatchEvent(new Event("focus"));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-08T00:00:00Z"));
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  resetNotifications();
  useAccountSessionStore.setState({ initialized: true, userId: "reader-1", displayName: "读者" });
  api.loadUnreadNotificationCount.mockReset().mockResolvedValue(3);
});

afterEach(() => {
  cleanup();
  resetNotifications();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("unread notification polling", () => {
  it("shares one five-minute poll across menus and stops after the last menu unmounts", async () => {
    const first = renderHook(useUnreadNotifications);
    const second = renderHook(useUnreadNotifications);
    await settle();
    expect(api.loadUnreadNotificationCount).toHaveBeenCalledTimes(1);
    expect(first.result.current.unreadCount).toBe(3);
    expect(second.result.current.unreadCount).toBe(3);

    await advance(299_999);
    expect(api.loadUnreadNotificationCount).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(api.loadUnreadNotificationCount).toHaveBeenCalledTimes(2);

    first.unmount();
    await advance(300_000);
    expect(api.loadUnreadNotificationCount).toHaveBeenCalledTimes(3);
    second.unmount();
    await advance(600_000);
    expect(api.loadUnreadNotificationCount).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never polls in the background and combines visibility and focus refreshes", async () => {
    renderHook(useUnreadNotifications);
    await settle();
    await setVisibility("hidden");
    await advance(3_600_000);
    expect(api.loadUnreadNotificationCount).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    await setVisibility("visible", true);
    expect(api.loadUnreadNotificationCount).toHaveBeenCalledTimes(2);
    await setVisibility("hidden");
    await advance(10_000);
    await setVisibility("visible", true);
    expect(api.loadUnreadNotificationCount).toHaveBeenCalledTimes(2);
    await advance(290_000);
    expect(api.loadUnreadNotificationCount).toHaveBeenCalledTimes(3);
  });

  it("waits for a background page to become visible before the initial request", async () => {
    visibility = "hidden";
    renderHook(useUnreadNotifications);
    await advance(600_000);
    expect(api.loadUnreadNotificationCount).not.toHaveBeenCalled();
    await setVisibility("visible", true);
    expect(api.loadUnreadNotificationCount).toHaveBeenCalledTimes(1);
  });

  it("keeps the next refresh due time when a menu remounts", async () => {
    const first = renderHook(useUnreadNotifications);
    await settle();
    first.unmount();
    await advance(240_000);
    renderHook(useUnreadNotifications);
    await settle();
    expect(api.loadUnreadNotificationCount).toHaveBeenCalledTimes(1);
    await advance(60_000);
    expect(api.loadUnreadNotificationCount).toHaveBeenCalledTimes(2);
  });

  it("shares an in-flight request with an explicit inbox refresh and allows an immediate later refresh", async () => {
    let resolveCount!: (count: number) => void;
    api.loadUnreadNotificationCount.mockReturnValueOnce(new Promise<number>((resolve) => { resolveCount = resolve; }));
    renderHook(useUnreadNotifications);
    const inboxRefresh = refreshUnreadNotifications("reader-1");
    await advance(60_000);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(api.loadUnreadNotificationCount).toHaveBeenCalledTimes(1);
    await act(async () => { resolveCount(2); await inboxRefresh; });
    expect(useNotificationStore.getState().unreadCount).toBe(2);

    await act(async () => { await refreshUnreadNotifications("reader-1"); });
    expect(api.loadUnreadNotificationCount).toHaveBeenCalledTimes(2);
  });

  it("continues at the slower interval after a failed request", async () => {
    api.loadUnreadNotificationCount.mockRejectedValueOnce(new Error("offline"));
    renderHook(useUnreadNotifications);
    await settle();
    expect(useNotificationStore.getState().loading).toBe(false);
    await advance(300_000);
    expect(api.loadUnreadNotificationCount).toHaveBeenCalledTimes(2);
    expect(useNotificationStore.getState().unreadCount).toBe(3);
  });

  it("does not immediately poll again after opening the inbox refreshed the count", async () => {
    renderHook(useUnreadNotifications);
    await settle();
    await advance(240_000);
    await act(async () => { await refreshUnreadNotifications("reader-1"); });
    await advance(60_000);
    expect(api.loadUnreadNotificationCount).toHaveBeenCalledTimes(2);
    await advance(240_000);
    expect(api.loadUnreadNotificationCount).toHaveBeenCalledTimes(3);
  });

  it("discards the previous account's pending count and stops on sign-out", async () => {
    let resolveOldCount!: (count: number) => void;
    api.loadUnreadNotificationCount.mockReturnValueOnce(new Promise<number>((resolve) => { resolveOldCount = resolve; }));
    const hook = renderHook(useUnreadNotifications);
    await act(async () => { useAccountSessionStore.setState({ userId: "reader-2" }); });
    expect(hook.result.current.unreadCount).toBe(3);
    await act(async () => { resolveOldCount(99); });
    expect(hook.result.current.unreadCount).toBe(3);
    await act(async () => { useAccountSessionStore.setState({ userId: null }); });
    expect(hook.result.current.unreadCount).toBe(0);
    await advance(600_000);
    expect(api.loadUnreadNotificationCount).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not overwrite a local mark-read update with an older count response", async () => {
    let resolveCount!: (count: number) => void;
    api.loadUnreadNotificationCount.mockReturnValueOnce(new Promise<number>((resolve) => { resolveCount = resolve; }));
    const refresh = refreshUnreadNotifications("reader-1");
    useNotificationStore.getState().setUnreadCount(3);
    useNotificationStore.getState().adjustUnreadCount(-1);
    resolveCount(3);
    await refresh;
    expect(useNotificationStore.getState().unreadCount).toBe(2);
  });
});
