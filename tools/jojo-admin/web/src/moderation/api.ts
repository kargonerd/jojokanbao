import { apiGet, apiPost } from "../lib/api";
import type { ModerationAction, ModerationItem, ModerationStatus } from "./types";

export const moderationApi = {
  async list(status: ModerationStatus): Promise<ModerationItem[]> {
    const result = await apiGet<{ success: true; items: ModerationItem[] }>(`/api/moderation/comments?status=${encodeURIComponent(status)}`);
    return result.items;
  },
  async moderate(commentId: string, action: ModerationAction, reason: string): Promise<void> {
    await apiPost(`/api/moderation/comments/${encodeURIComponent(commentId)}`, {
      action,
      reason,
      requestId: crypto.randomUUID(),
    });
  },
};
