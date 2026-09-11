import type { JojoAuthClient } from "./client";

export interface ScrapbookSource {
  contentType: "book" | "newspaper" | "magazine";
  contentId: string;
  contentTitle: string;
  sectionId: string;
  locationLabel: string;
  contentUrl: string;
}

export interface ScrapbookDraft extends ScrapbookSource {
  quote: string;
  note: string;
  collection: string;
}

export interface ScrapbookEntry extends ScrapbookDraft {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export const SCRAPBOOK_PAGE_SIZE = 50;

/** Only local reader routes may be saved or opened, on all three clients. */
export function safeScrapbookPath(value: string): string | undefined {
  if (!/^\/(?:book|archive)\/[^\s\\<>]+$/u.test(value)) return undefined;
  try {
    const parsed = new URL(value, "https://reader.jojokanbao.cn");
    if (parsed.origin !== "https://reader.jojokanbao.cn" || !/^\/(?:book|archive)\//u.test(parsed.pathname)) return undefined;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch { return undefined; }
}

export function validateScrapbookDraft(draft: ScrapbookDraft): ScrapbookDraft {
  const result = Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, value.trim()])) as unknown as ScrapbookDraft;
  if (!["book", "newspaper", "magazine"].includes(result.contentType)
    || !result.contentId || result.contentId.length > 500
    || !result.contentTitle || result.contentTitle.length > 500
    || !result.sectionId || result.sectionId.length > 500
    || result.locationLabel.length > 500
    || !safeScrapbookPath(result.contentUrl) || result.contentUrl.length > 4000) throw new Error("这条资料缺少有效的原文出处，请重新打开阅读页。");
  if (!result.quote && !result.note) throw new Error("请填写摘录或笔记。");
  if (result.quote.length > 6000 || result.note.length > 8000 || result.collection.length > 80) throw new Error("摘录、笔记或专题名称过长。");
  return result;
}

function decodeEntry(value: unknown): ScrapbookEntry {
  const row = value as Record<string, unknown>;
  if (!row || typeof row.id !== "string" || !row.id
    || !["content_type", "content_id", "content_title", "section_id", "content_url", "created_at", "updated_at", "quote", "note", "collection"].every((key) => typeof row[key] === "string")
    || !["book", "newspaper", "magazine"].includes(String(row.content_type))
    || !safeScrapbookPath(String(row.content_url))
    || !Number.isFinite(Date.parse(String(row.created_at))) || !Number.isFinite(Date.parse(String(row.updated_at)))) throw new Error("剪报数据格式无效。");
  return {
    id: row.id,
    contentType: row.content_type as ScrapbookEntry["contentType"],
    contentId: String(row.content_id), contentTitle: String(row.content_title),
    sectionId: String(row.section_id), locationLabel: String(row.location_label ?? ""),
    contentUrl: String(row.content_url), quote: String(row.quote ?? ""),
    note: String(row.note ?? ""), collection: String(row.collection ?? ""),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

export function createScrapbookRepository(client: JojoAuthClient, ownerId: string) {
  // These additive RPCs are available after the scrapbook migration is applied.
  const rpcClient = client as unknown as { rpc(name: string, params: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> };
  async function call(name: string, params: Record<string, unknown> = {}) {
    if (!ownerId) throw new Error("请先登录再使用剪报本。");
    const { data, error } = await rpcClient.rpc(name, { ...params, p_expected_user_id: ownerId });
    if (error) throw new Error("剪报本暂时无法连接，请检查网络后重试。");
    return data;
  }
  return {
    async list(query = "", collection: string | null = null, offset = 0): Promise<ScrapbookEntry[]> {
      const data = await call("get_reader_clippings", { p_query: query.trim(), p_collection: collection, p_offset: offset, p_limit: SCRAPBOOK_PAGE_SIZE });
      if (!Array.isArray(data)) throw new Error("剪报本返回了无效结果。");
      return data.map(decodeEntry);
    },
    async collections(): Promise<string[]> {
      const data = await call("get_reader_clipping_collections");
      if (!Array.isArray(data)) throw new Error("专题列表返回了无效结果。");
      return data.filter((value): value is string => typeof value === "string");
    },
    async save(draft: ScrapbookDraft, id?: string): Promise<ScrapbookEntry> {
      const input = validateScrapbookDraft(draft);
      return decodeEntry(await call("save_reader_clipping", { p_id: id ?? null, p_content_type: input.contentType,
        p_content_id: input.contentId, p_content_title: input.contentTitle, p_section_id: input.sectionId,
        p_location_label: input.locationLabel, p_content_url: input.contentUrl,
        p_quote: input.quote, p_note: input.note, p_collection: input.collection }));
    },
    async remove(id: string): Promise<void> {
      await call("delete_reader_clipping", { p_id: id });
    },
  };
}

export type ScrapbookRepository = ReturnType<typeof createScrapbookRepository>;

export function scrapbookMarkdown(entries: readonly ScrapbookEntry[]): string {
  const plain = (text: string) => text.replace(/[\\`*_{}\[\]<>#]/gu, "\\$&");
  return "# 我的剪报本\n\n" + entries.map((entry) => {
    const path = safeScrapbookPath(entry.contentUrl);
    const quote = entry.quote ? entry.quote.split(/\r?\n/u).map((line) => `> ${plain(line)}`).join("\n") + "\n\n" : "";
    return `## ${plain(entry.contentTitle)}\n\n${quote}${entry.note ? plain(entry.note) + "\n\n" : ""}`
      + `出处：${plain(entry.contentTitle)} ${plain(entry.locationLabel)}\n\n`
      + (path ? `[返回原文](https://reader.jojokanbao.cn${path.replace(/\(/gu, "%28").replace(/\)/gu, "%29")})\n\n` : "")
      + (entry.collection ? `专题：${plain(entry.collection)}\n\n` : "");
  }).join("---\n\n");
}
