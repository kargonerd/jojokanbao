export interface ReusableExplanation {
  quote: string;
  answer: string;
  count: number;
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
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

export async function reusableExplanation(datasetId: string, itemId: string, quote: string): Promise<ReusableExplanation | undefined> {
  const { client } = await sessionClient();
  const key = phraseKey(quote);
  const { data, error } = await client.rpc("get_reusable_reader_explanation", { p_dataset_id: datasetId, p_item_id: itemId, p_phrase_key: key });
  if (error) throw error;
  const result = data?.[0];
  return result?.answer ? { quote: result.quote, answer: result.answer, count: Number(result.explanation_count) } : undefined;
}

export async function popularExplanations(datasetId: string, itemId: string, chapterId: string): Promise<ReusableExplanation[]> {
  const { client } = await sessionClient();
  const { data, error } = await client.rpc("get_popular_reader_explanations", { p_dataset_id: datasetId, p_item_id: itemId, p_chapter_id: chapterId });
  if (error) throw error;
  return (data ?? []).map((row: any) => ({ quote: row.quote, answer: row.answer, count: Number(row.explanation_count) }));
}

export async function saveExplanation(input: { datasetId: string; itemId: string; chapterId: string; quote: string; answer?: string }): Promise<void> {
  const { client, userId: id } = await sessionClient();
  const { error } = await client.from("reader_ai_explanations").upsert({ user_id: id, dataset_id: input.datasetId, item_id: input.itemId, chapter_id: input.chapterId, phrase_key: phraseKey(input.quote), quote: input.quote, answer: input.answer ?? null, updated_at: new Date().toISOString() }, { onConflict: "user_id,dataset_id,item_id,phrase_key" });
  if (error) throw error;
}
