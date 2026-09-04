import { mobileAuthClient } from "./auth";

export interface MobileNotification {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  targetPath: string | null;
  resourceType: string | null;
  resourceId: string | null;
  payload: Record<string, unknown>;
  actorId: string | null;
  actorName: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface MobileNotificationCursor {
  id: string;
  createdAt: string;
}

export interface MobileBookshelfEntry {
  datasetId: string;
  itemId: string;
  title: string;
}

async function currentUserId(): Promise<string> {
  const { data, error } = await mobileAuthClient.auth.getUser();
  if (error) throw error;
  if (!data.user) throw new Error("请先登录后使用账号功能");
  return data.user.id;
}

// These APIs are deployed by migrations ahead of the generated Supabase type.
// Keep the untyped boundary here so screens remain fully typed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function accountClient(): any {
  return mobileAuthClient as any;
}

function requiredResult<T>(data: T | null, error: unknown, message: string): T {
  if (error || data === null) throw new Error(message);
  return data;
}

export async function loadMobileNotifications(
  limit = 50,
  before?: MobileNotificationCursor,
): Promise<MobileNotification[]> {
  const { data, error } = await accountClient().rpc("get_my_notifications", {
    p_limit: limit,
    p_before: before?.createdAt ?? null,
    p_before_id: before?.id ?? null,
  });
  const result = requiredResult<unknown>(data, error, "通知暂时无法读取");
  return Array.isArray(result) ? result as MobileNotification[] : [];
}

export async function loadMobileUnreadNotificationCount(): Promise<number> {
  const { data, error } = await accountClient().rpc("get_my_unread_notification_count");
  return Number(requiredResult<number>(data, error, "未读通知暂时无法读取")) || 0;
}

export async function markMobileNotificationRead(notificationId?: string): Promise<number> {
  const { data, error } = await accountClient().rpc("mark_my_notification_read", {
    p_notification_id: notificationId ?? null,
  });
  return Number(requiredResult<number>(data, error, "通知状态更新失败")) || 0;
}

export async function loadMobileBookshelf(): Promise<MobileBookshelfEntry[]> {
  const userId = await currentUserId();
  const { data, error } = await accountClient()
    .from("reader_bookshelf")
    .select("dataset_id,item_id,title")
    .eq("user_id", userId)
    .order("added_at", { ascending: false });
  if (error) throw new Error("书架暂时无法载入");
  return (data ?? []).map((row: { dataset_id: string; item_id: string; title: string }) => ({
    datasetId: row.dataset_id,
    itemId: row.item_id,
    title: row.title,
  }));
}

export async function mobileBookshelfContains(datasetId: string, itemId: string): Promise<boolean> {
  const userId = await currentUserId();
  const { data, error } = await accountClient()
    .from("reader_bookshelf")
    .select("item_id")
    .eq("user_id", userId)
    .eq("dataset_id", datasetId)
    .eq("item_id", itemId)
    .maybeSingle();
  if (error) throw new Error("书架状态暂时无法读取");
  return Boolean(data);
}

export async function setMobileBookshelf(input: MobileBookshelfEntry & { added: boolean }): Promise<void> {
  const userId = await currentUserId();
  if (input.added) {
    const { error } = await accountClient().from("reader_bookshelf").upsert({
      user_id: userId,
      dataset_id: input.datasetId,
      item_id: input.itemId,
      title: input.title,
    });
    if (error) throw new Error("暂时无法加入书架");
    return;
  }
  const { error } = await accountClient()
    .from("reader_bookshelf")
    .delete()
    .eq("user_id", userId)
    .eq("dataset_id", input.datasetId)
    .eq("item_id", input.itemId);
  if (error) throw new Error("暂时无法移出书架");
}
