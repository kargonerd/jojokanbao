import type { RagAnswerMetadata, RagReference } from "./types";

const READER_AI_PROMPT_VERSION = "reader-focus-v1";
const READER_AI_CONTEXT_KEY_CHARACTERS = 240;

export interface ReusableExplanation {
  quote: string;
  answer: string;
  count: number;
  references: RagReference[];
  prefix?: string;
  suffix?: string;
}

export interface BookshelfEntry { datasetId: string; itemId: string; title: string; }

// Reader data tables are added by the migration in this PR; the shared generated
// Database type intentionally remains stable until the migration is deployed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sessionClient(): Promise<{ client: any; userId: string }> {
  const { authClient } = await import("../account/auth");
  const { data, error } = await authClient.auth.getUser();
  if (error) throw error;
  if (!data.user) throw new Error("请先登录后保存阅读数据");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: authClient as any, userId: data.user.id };
}

export async function bookshelfContains(datasetId: string, itemId: string): Promise<boolean> {
  const { client, userId: id } = await sessionClient();
  const { data, error } = await client.from("reader_bookshelf").select("item_id").eq("user_id", id).eq("dataset_id", datasetId).eq("item_id", itemId).maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function loadBookshelf(): Promise<BookshelfEntry[]> {
  const { client, userId: id } = await sessionClient();
  const { data, error } = await client.from("reader_bookshelf").select("dataset_id,item_id,title").eq("user_id", id).order("added_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row: any) => ({ datasetId: row.dataset_id, itemId: row.item_id, title: row.title }));
}

export async function setBookshelf(input: { datasetId: string; itemId: string; title: string; added: boolean }): Promise<void> {
  const { client, userId: id } = await sessionClient();
  if (input.added) {
    const { error } = await client.from("reader_bookshelf").upsert({ user_id: id, dataset_id: input.datasetId, item_id: input.itemId, title: input.title });
    if (error) throw error;
  } else {
    const { error } = await client.from("reader_bookshelf").delete().eq("user_id", id).eq("dataset_id", input.datasetId).eq("item_id", input.itemId);
    if (error) throw error;
  }
}

export function phraseKey(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export function explanationContextKey(quote: string, prefix = "", suffix = ""): string {
  return JSON.stringify([
    phraseKey(prefix).slice(-READER_AI_CONTEXT_KEY_CHARACTERS),
    phraseKey(quote),
    phraseKey(suffix).slice(0, READER_AI_CONTEXT_KEY_CHARACTERS),
  ]);
}

export async function reusableExplanation(
  datasetId: string,
  itemId: string,
  chapterId: string,
  quote: string,
  context: { prefix?: string; suffix?: string } = {},
): Promise<ReusableExplanation | undefined> {
  const { client } = await sessionClient();
  const key = explanationContextKey(quote, context.prefix, context.suffix);
  const { data, error } = await client.rpc("get_reader_ai_explanation_cache", { p_dataset_id: datasetId, p_item_id: itemId, p_chapter_id: chapterId, p_context_key: key, p_prompt_version: READER_AI_PROMPT_VERSION });
  if (error) throw error;
  const result = data?.[0];
  return result?.answer ? {
    quote: result.quote,
    answer: result.answer,
    count: Number(result.query_count),
    references: Array.isArray(result.references) ? result.references as RagReference[] : [],
    ...(typeof result.prefix === "string" && result.prefix ? { prefix: result.prefix } : {}),
    ...(typeof result.suffix === "string" && result.suffix ? { suffix: result.suffix } : {}),
  } : undefined;
}

export async function popularExplanations(datasetId: string, itemId: string, chapterId: string): Promise<ReusableExplanation[]> {
  const { client } = await sessionClient();
  const { data, error } = await client.rpc("get_popular_reader_ai_explanations", { p_dataset_id: datasetId, p_item_id: itemId, p_chapter_id: chapterId, p_prompt_version: READER_AI_PROMPT_VERSION });
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    quote: row.quote,
    answer: row.answer,
    count: Number(row.query_count),
    references: Array.isArray(row.references) ? row.references as RagReference[] : [],
    ...(typeof row.prefix === "string" && row.prefix ? { prefix: row.prefix } : {}),
    ...(typeof row.suffix === "string" && row.suffix ? { suffix: row.suffix } : {}),
  }));
}

export async function saveExplanation(input: { datasetId: string; itemId: string; chapterId: string; quote: string; prefix?: string; suffix?: string; answer: string; references?: RagReference[]; metadata?: RagAnswerMetadata }): Promise<void> {
  const { client } = await sessionClient();
  const model = [input.metadata?.provider, input.metadata?.model].filter(Boolean).join("/") || "unknown";
  const { error } = await client.rpc("put_reader_ai_explanation_cache", {
    p_dataset_id: input.datasetId,
    p_item_id: input.itemId,
    p_chapter_id: input.chapterId,
    p_context_key: explanationContextKey(input.quote, input.prefix, input.suffix),
    p_quote: input.quote,
    p_prefix: input.prefix ?? "",
    p_suffix: input.suffix ?? "",
    p_answer: input.answer,
    p_references: input.references ?? [],
    p_model: model,
    p_prompt_version: READER_AI_PROMPT_VERSION,
  });
  if (error) throw error;
}
