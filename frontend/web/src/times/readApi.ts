export interface TimesArticleRead {
  articleId: string;
  readAt: string;
}

async function rpc(name: string, params: Record<string, unknown>) {
  const { authClient } = await import("../account/auth");
  // The matching migration intentionally exposes narrow RPCs instead of the table.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (authClient as any).rpc(name, params);
}

function throwIfError(error: { message?: string } | null, fallback: string): void {
  if (error) throw new Error(error.message || fallback);
}

export async function loadTimesArticleReads(articleIds: string[]): Promise<TimesArticleRead[]> {
  if (!articleIds.length) return [];
  const { data, error } = await rpc("get_my_times_article_reads", {
    p_article_ids: articleIds.slice(0, 500),
  });
  throwIfError(error, "读取状态暂时不可用");
  if (!Array.isArray(data)) return [];
  return data.flatMap((candidate: unknown) => {
    if (!candidate || typeof candidate !== "object") return [];
    const row = candidate as { article_id?: unknown; read_at?: unknown };
    return typeof row.article_id === "string" && typeof row.read_at === "string"
      ? [{ articleId: row.article_id, readAt: row.read_at }]
      : [];
  });
}

export async function markTimesArticleRead(articleId: string, issueDate: string): Promise<void> {
  const { error } = await rpc("mark_my_times_article_read", {
    p_article_id: articleId,
    p_issue_date: issueDate,
  });
  throwIfError(error, "标记已读失败");
}

export async function markTimesArticleUnread(articleId: string): Promise<void> {
  const { error } = await rpc("mark_my_times_article_unread", {
    p_article_id: articleId,
  });
  throwIfError(error, "标记未读失败");
}
