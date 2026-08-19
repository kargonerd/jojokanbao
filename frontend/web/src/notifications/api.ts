import type { UserNotification } from "./types";

const useMockNotifications = import.meta.env.DEV && import.meta.env.VITE_MOCK_NOTIFICATIONS === "true";

async function rpc(name: string, params: Record<string, unknown> = {}) {
  const { authClient } = await import("../account/auth");
  // The migration ships before the generated Supabase type is refreshed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (authClient as any).rpc(name, params);
}

function resultOrThrow<T>(data: T | null, error: { code?: string; message?: string } | null, fallback: string): T {
  if (error) {
    const rpcMissing = error.code === "PGRST202" || error.message?.includes("Could not find the function");
    throw new Error(rpcMissing ? "通知服务尚未完成数据库配置，请先部署最新 Supabase migration。" : error.message || fallback);
  }
  if (data === null) throw new Error(fallback);
  return data;
}

export async function loadNotifications(limit = 50, before?: string): Promise<UserNotification[]> {
  if (useMockNotifications) {
    const { readMockNotifications } = await import("./mock");
    return readMockNotifications(before).slice(0, limit);
  }
  const { data, error } = await rpc("get_my_notifications", {
    p_limit: limit,
    p_before: before || null,
  });
  const result = resultOrThrow<unknown>(data, error, "通知暂时无法读取");
  return Array.isArray(result) ? result as UserNotification[] : [];
}

export async function loadUnreadNotificationCount(): Promise<number> {
  if (useMockNotifications) {
    const { mockUnreadCount } = await import("./mock");
    return mockUnreadCount();
  }
  const { data, error } = await rpc("get_my_unread_notification_count");
  return Number(resultOrThrow<number>(data, error, "未读通知暂时无法读取")) || 0;
}

export async function markNotificationRead(notificationId?: string): Promise<number> {
  if (useMockNotifications) {
    const { markMockNotificationRead } = await import("./mock");
    return markMockNotificationRead(notificationId);
  }
  const { data, error } = await rpc("mark_my_notification_read", {
    p_notification_id: notificationId || null,
  });
  return Number(resultOrThrow<number>(data, error, "通知状态更新失败")) || 0;
}
