import { gzipSync, gunzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { load, type CheerioAPI } from "cheerio";
import { sha256 } from "../identity.js";
import type { ProcessedArticleTranslation, ProcessedCandidate } from "../process/article.js";

const TRANSLATION_FORMAT = "jojo-times-translation/1" as const;
export const TIMES_TRANSLATION_POLICY = "gemma-news-zh-v1" as const;
export const TIMES_TRANSLATION_DEFAULTS = {
  workers: 8,
  requestTimeoutMs: 240_000,
  batchTimeoutMs: 480_000,
  maxChunkCharacters: 20_000,
  requestsPerMinute: 28,
  tokensPerMinute: 14_000,
} as const;
const TARGET_LANGUAGE = "zh-CN" as const;
const BLOCK_SELECTOR = "p,h1,h2,h3,h4,blockquote,figcaption,li,td,th";
const INLINE_MARKER = /\[\[JOJO_INLINE_(i\d+)_(START|END|EMPTY)\]\]/gu;

interface InlineNode {
  type: string;
  data?: string;
  children?: InlineNode[];
}

interface InlineTemplate {
  opening: string;
  closing: string;
  empty: boolean;
}

interface TranslationBlock {
  id: string;
  tag: string;
  text: string;
}

interface TranslationPayload {
  title: string;
  blocks: Array<{ id: string; text: string }>;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string };
}

interface RateEvent {
  at: number;
  tokens: number;
}

interface StoredTranslation extends ProcessedArticleTranslation {
  formatVersion: typeof TRANSLATION_FORMAT;
  policy: typeof TIMES_TRANSLATION_POLICY;
  articleId: string;
  sourceLanguage: string;
}

export interface GemmaTranslationOptions {
  apiKey: string;
  primaryModel?: string;
  fallbackModel?: string;
  workers?: number;
  requestTimeoutMs?: number;
  batchTimeoutMs?: number;
  maxChunkCharacters?: number;
  requestsPerMinute?: number;
  tokensPerMinute?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  onProgress?: (message: string) => void;
}

export interface TranslationFailure {
  articleId: string;
  sourceId: string;
  title: string;
  error: string;
}

export interface TranslationBatchStats {
  eligible: number;
  translated: number;
  cacheHits: number;
  failed: number;
  notRequired: number;
  requests: number;
  fallbackChunks: number;
  promptTokens: number;
  outputTokens: number;
  durationMs: number;
  failures: TranslationFailure[];
}

export interface TranslationBatchResult {
  candidates: ProcessedCandidate[];
  stats: TranslationBatchStats;
}

interface ArticleTranslationResult {
  candidate: ProcessedCandidate;
  status: "translated" | "cached" | "failed" | "not-required";
  requests: number;
  fallbackChunks: number;
  promptTokens: number;
  outputTokens: number;
  failure?: TranslationFailure;
}

class MinuteRateLimiter {
  private readonly events: RateEvent[] = [];

  constructor(private readonly requestsPerMinute: number, private readonly tokensPerMinute: number) {}

  async acquire(estimatedTokens: number, deadlineAt?: number): Promise<RateEvent> {
    const reservedTokens = Math.min(Math.max(1, estimatedTokens), this.tokensPerMinute);
    for (;;) {
      const now = Date.now();
      while (this.events[0] && now - this.events[0].at >= 60_000) this.events.shift();
      const tokens = this.events.reduce((sum, event) => sum + event.tokens, 0);
      if (this.events.length < this.requestsPerMinute && tokens + reservedTokens <= this.tokensPerMinute) {
        const event = { at: now, tokens: reservedTokens };
        this.events.push(event);
        return event;
      }
      const waitMs = Math.max(50, 60_050 - (now - (this.events[0]?.at ?? now)));
      if (deadlineAt !== undefined && now + waitMs >= deadlineAt) throw new Error("Translation batch deadline exceeded while rate limited");
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < 1) throw new Error(`${name} must be a positive integer`);
  return selected;
}

function chineseLanguage(language: string): boolean {
  const normalized = language.trim().toLowerCase().replaceAll("_", "-");
  return normalized === "zh" || normalized.startsWith("zh-") || normalized === "cmn" || normalized.startsWith("cmn-");
}

function leafBlockElements(document: CheerioAPI): ReturnType<CheerioAPI>[number][] {
  const elements: ReturnType<CheerioAPI>[number][] = [];
  document(BLOCK_SELECTOR).each((_index, element) => {
    if (document(element).find(BLOCK_SELECTOR).length > 0) return;
    if (!document(element).text().replace(/\s+/gu, " ").trim()) return;
    elements.push(element);
  });
  return elements;
}

function inlineMarker(id: string, kind: "START" | "END" | "EMPTY"): string {
  return `[[JOJO_INLINE_${id}_${kind}]]`;
}

function markedBlockText(document: CheerioAPI, element: ReturnType<CheerioAPI>[number]): string {
  let inlineIndex = 0;
  const render = (node: InlineNode): string => {
    if (node.type === "text") return node.data ?? "";
    if (node.type !== "tag") return (node.children ?? []).map(render).join("");
    const id = `i${++inlineIndex}`;
    const children = (node.children ?? []).map(render).join("");
    return children
      ? `${inlineMarker(id, "START")}${children}${inlineMarker(id, "END")}`
      : inlineMarker(id, "EMPTY");
  };
  return document(element).contents().toArray().map((node) => render(node as InlineNode)).join("").replace(/\s+/gu, " ").trim();
}

function inlineTemplates(document: CheerioAPI, element: ReturnType<CheerioAPI>[number]): Map<string, InlineTemplate> {
  const templates = new Map<string, InlineTemplate>();
  let inlineIndex = 0;
  const visit = (node: InlineNode): void => {
    if (node.type !== "tag") {
      for (const child of node.children ?? []) visit(child);
      return;
    }
    const id = `i${++inlineIndex}`;
    const selected = document(node as ReturnType<CheerioAPI>[number]);
    const outer = document.html(selected);
    const openingEnd = outer.indexOf(">");
    if (openingEnd < 0) throw new Error(`Cannot preserve inline element ${id}`);
    const tag = String(selected.prop("tagName") ?? "").toLowerCase();
    const hasChildren = (node.children?.length ?? 0) > 0;
    templates.set(id, {
      opening: outer.slice(0, openingEnd + 1),
      closing: hasChildren ? `</${tag}>` : outer.slice(openingEnd + 1),
      empty: !hasChildren,
    });
    for (const child of node.children ?? []) visit(child);
  };
  for (const node of document(element).contents().toArray()) visit(node as InlineNode);
  return templates;
}

function markerTokens(value: string): string[] {
  return [...value.matchAll(INLINE_MARKER)].map((match) => match[0]);
}

function escapeTranslatedText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function translatedBlockHtml(
  document: CheerioAPI,
  element: ReturnType<CheerioAPI>[number],
  originalText: string,
  translatedText: string,
): string {
  const expectedMarkers = markerTokens(originalText);
  const receivedMarkers = markerTokens(translatedText);
  if (expectedMarkers.length !== receivedMarkers.length
    || expectedMarkers.some((marker, index) => marker !== receivedMarkers[index])) {
    throw new Error("Gemma changed inline element markers");
  }
  const templates = inlineTemplates(document, element);
  const stack: string[] = [];
  let html = "";
  let cursor = 0;
  for (const match of translatedText.matchAll(INLINE_MARKER)) {
    html += escapeTranslatedText(translatedText.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const id = match[1]!;
    const kind = match[2]!;
    const template = templates.get(id);
    if (!template) throw new Error(`Gemma returned unknown inline marker ${id}`);
    if (kind === "START" && !template.empty) {
      stack.push(id);
      html += template.opening;
    } else if (kind === "END" && !template.empty && stack.pop() === id) {
      html += template.closing;
    } else if (kind === "EMPTY" && template.empty) {
      html += `${template.opening}${template.closing}`;
    } else {
      throw new Error(`Gemma returned invalid inline marker ${id} ${kind}`);
    }
  }
  if (stack.length) throw new Error("Gemma returned unclosed inline markers");
  return `${html}${escapeTranslatedText(translatedText.slice(cursor))}`;
}

export function extractArticleTranslationBlocks(body: string): TranslationBlock[] {
  const document = load(body, undefined, false);
  return leafBlockElements(document).map((element, index) => ({
    id: `b${index + 1}`,
    tag: String(document(element).prop("tagName") ?? "p").toLowerCase(),
    text: markedBlockText(document, element),
  }));
}

export function applyArticleTranslation(body: string, blocks: TranslationPayload["blocks"]): string {
  const document = load(body, undefined, false);
  const elements = leafBlockElements(document);
  if (elements.length !== blocks.length || elements.some((_element, index) => blocks[index]?.id !== `b${index + 1}`)) {
    throw new Error(`Translated block structure mismatch: expected ${elements.length}, received ${blocks.length}`);
  }
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index]!;
    const originalText = markedBlockText(document, element);
    document(element).html(translatedBlockHtml(document, element, originalText, blocks[index]!.text));
  }
  return document.html().trim();
}

function splitBlocks(title: string, blocks: TranslationBlock[], maxCharacters: number): TranslationBlock[][] {
  if (!blocks.length) return [[]];
  const chunks: TranslationBlock[][] = [];
  let current: TranslationBlock[] = [];
  let characters = title.length;
  for (const block of blocks) {
    if (current.length > 0 && characters + block.text.length > maxCharacters) {
      chunks.push(current);
      current = [];
      characters = title.length;
    }
    current.push(block);
    characters += block.text.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function translationPrompt(title: string, sourceLanguage: string, blocks: TranslationBlock[]): string {
  return [
    `Translate the complete news content from ${sourceLanguage} into accurate, natural Simplified Chinese.`,
    "Rules:",
    "1. Translate the title and every block. Do not summarize, omit, merge, add, explain, or fact-check.",
    "2. Preserve meaning, uncertainty, tone, quotations, names, numbers, dates, currencies, units, and acronyms.",
    "3. Keep every block id and the original block order exactly. Return one translated block for every input block.",
    "4. Preserve every [[JOJO_INLINE_iN_START]], [[JOJO_INLINE_iN_END]], and [[JOJO_INLINE_iN_EMPTY]] marker exactly, in the same order. Translate only the surrounding text.",
    "5. Preserve email addresses, URLs, author names, and identifiers when they should not be translated.",
    "6. Output JSON only: {\"title\":\"...\",\"blocks\":[{\"id\":\"b1\",\"text\":\"...\"}]}",
    "INPUT:",
    JSON.stringify({ title, blocks: blocks.map(({ id, text }) => ({ id, text })) }),
  ].join("\n");
}

function parsePayload(value: string, expected: TranslationBlock[]): TranslationPayload {
  const text = value.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  const parsed = JSON.parse(text) as Partial<TranslationPayload>;
  if (typeof parsed.title !== "string" || !parsed.title.trim() || !Array.isArray(parsed.blocks)) {
    throw new Error("Gemma returned an invalid translation payload");
  }
  if (parsed.blocks.length !== expected.length || parsed.blocks.some((block, index) => (
    !block || block.id !== expected[index]?.id || typeof block.text !== "string" || !block.text.trim()
  ))) {
    throw new Error(`Gemma returned invalid block structure: expected ${expected.length}, received ${parsed.blocks.length}`);
  }
  return { title: parsed.title.trim(), blocks: parsed.blocks.map((block) => ({ id: block.id, text: block.text.trim() })) };
}

function estimatedPromptTokens(prompt: string): number {
  return Math.ceil(prompt.length / 3.5) + 300;
}

function safeCachePath(output: string, objectName: string): string {
  const root = path.resolve(output);
  const normalized = objectName.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) throw new Error(`Unsafe translation cache path: ${objectName}`);
  const target = path.resolve(root, ...normalized.split("/"));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error(`Unsafe translation cache path: ${objectName}`);
  return target;
}

export function translationCacheObject(candidate: Pick<ProcessedCandidate, "sourceId" | "publishedAt">, sourceHash: string): string {
  const date = new Date(candidate.publishedAt).toISOString().slice(0, 10);
  return `canonical/${candidate.sourceId}/translations/${TIMES_TRANSLATION_POLICY}/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}/${sourceHash}.json.gz`;
}

function sourceHash(candidate: ProcessedCandidate): string {
  return sha256(JSON.stringify({
    policy: TIMES_TRANSLATION_POLICY,
    language: candidate.language,
    title: candidate.title,
    body: candidate.processedBody,
  }));
}

async function cachedTranslation(output: string, objectName: string, expectedHash: string): Promise<StoredTranslation | undefined> {
  try {
    const parsed = JSON.parse(gunzipSync(await readFile(safeCachePath(output, objectName))).toString("utf8")) as StoredTranslation;
    if (parsed.formatVersion !== TRANSLATION_FORMAT || parsed.policy !== TIMES_TRANSLATION_POLICY || parsed.sourceHash !== expectedHash
      || parsed.language !== TARGET_LANGUAGE || typeof parsed.title !== "string" || typeof parsed.body?.value !== "string") return undefined;
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeCachedTranslation(output: string, objectName: string, translation: StoredTranslation): Promise<void> {
  const target = safeCachePath(output, objectName);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, gzipSync(`${JSON.stringify(translation)}\n`, { level: 9 }));
}

class GemmaClient {
  private readonly limiters = new Map<string, MinuteRateLimiter>();
  private requestCount = 0;
  private promptTokenCount = 0;
  private outputTokenCount = 0;

  constructor(private readonly options: Required<Pick<GemmaTranslationOptions,
    "apiKey" | "requestTimeoutMs" | "requestsPerMinute" | "tokensPerMinute" | "fetchImpl">>) {}

  metrics(): { requests: number; promptTokens: number; outputTokens: number } {
    return { requests: this.requestCount, promptTokens: this.promptTokenCount, outputTokens: this.outputTokenCount };
  }

  async translate(model: string, prompt: string, deadlineAt: number): Promise<string> {
    if (Date.now() >= deadlineAt) throw new Error("Translation batch deadline exceeded");
    let limiter = this.limiters.get(model);
    if (!limiter) {
      limiter = new MinuteRateLimiter(this.options.requestsPerMinute, this.options.tokensPerMinute);
      this.limiters.set(model, limiter);
    }
    const event = await limiter.acquire(estimatedPromptTokens(prompt), deadlineAt);
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) throw new Error("Translation batch deadline exceeded");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(this.options.requestTimeoutMs, remainingMs));
    this.requestCount += 1;
    try {
      const response = await this.options.fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.options.apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 32_768,
            responseMimeType: "application/json",
            thinkingConfig: { thinkingLevel: "minimal" },
          },
        }),
        signal: controller.signal,
      });
      const payload = await response.json() as GeminiResponse;
      if (!response.ok) throw new Error(payload.error?.message ?? `Gemini returned HTTP ${response.status}`);
      const candidate = payload.candidates?.[0];
      const text = candidate?.content?.parts?.filter((part) => !part.thought).map((part) => part.text ?? "").join("").trim() ?? "";
      if (!text) throw new Error(`Gemma returned no final text (${candidate?.finishReason ?? "unknown"})`);
      const promptTokens = payload.usageMetadata?.promptTokenCount ?? event.tokens;
      event.tokens = promptTokens;
      this.promptTokenCount += promptTokens;
      this.outputTokenCount += payload.usageMetadata?.candidatesTokenCount ?? 0;
      return text;
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function mapLimit<T, R>(values: readonly T[], concurrency: number, work: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  async function consume(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= values.length) return;
      output[index] = await work(values[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, consume));
  return output;
}

export async function translateProcessedCandidates(
  output: string,
  candidates: readonly ProcessedCandidate[],
  options: GemmaTranslationOptions,
): Promise<TranslationBatchResult> {
  if (!options.apiKey.trim()) throw new Error("Gemma translation requires a non-empty API key");
  const workers = positiveInteger(options.workers, TIMES_TRANSLATION_DEFAULTS.workers, "Translation workers");
  const requestTimeoutMs = positiveInteger(options.requestTimeoutMs, TIMES_TRANSLATION_DEFAULTS.requestTimeoutMs, "Translation request timeout");
  const batchTimeoutMs = positiveInteger(options.batchTimeoutMs, TIMES_TRANSLATION_DEFAULTS.batchTimeoutMs, "Translation batch timeout");
  const maxChunkCharacters = positiveInteger(options.maxChunkCharacters, TIMES_TRANSLATION_DEFAULTS.maxChunkCharacters, "Translation chunk size");
  const requestsPerMinute = positiveInteger(options.requestsPerMinute, TIMES_TRANSLATION_DEFAULTS.requestsPerMinute, "Translation RPM");
  const tokensPerMinute = positiveInteger(options.tokensPerMinute, TIMES_TRANSLATION_DEFAULTS.tokensPerMinute, "Translation TPM");
  const primaryModel = options.primaryModel?.trim() || "gemma-4-31b-it";
  const fallbackModel = options.fallbackModel?.trim() || "gemma-4-26b-a4b-it";
  const now = options.now ?? (() => new Date());
  const client = new GemmaClient({
    apiKey: options.apiKey,
    requestTimeoutMs,
    requestsPerMinute,
    tokensPerMinute,
    fetchImpl: options.fetchImpl ?? fetch,
  });
  const started = Date.now();
  const deadlineAt = started + batchTimeoutMs;

  const rows = await mapLimit(candidates, workers, async (candidate, index): Promise<ArticleTranslationResult> => {
    if (!candidate.processedBody || candidate.contentStatus !== "full" || chineseLanguage(candidate.language)) {
      return { candidate, status: "not-required", requests: 0, fallbackChunks: 0, promptTokens: 0, outputTokens: 0 };
    }
    const hash = sourceHash(candidate);
    const cacheObject = translationCacheObject(candidate, hash);
    let cached: StoredTranslation | undefined;
    try {
      cached = await cachedTranslation(output, cacheObject, hash);
    } catch (error) {
      options.onProgress?.(`[translation] ignoring invalid cache ${cacheObject}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (cached) {
      options.onProgress?.(`[translation] ${index + 1}/${candidates.length} cache ${candidate.sourceId} ${candidate.title.slice(0, 80)}`);
      return {
        candidate: { ...candidate, translation: cached, translationCacheObject: cacheObject, translationStatus: "cached" },
        status: "cached",
        requests: 0,
        fallbackChunks: 0,
        promptTokens: 0,
        outputTokens: 0,
      };
    }
    options.onProgress?.(`[translation] ${index + 1}/${candidates.length} ${candidate.sourceId} ${candidate.title.slice(0, 80)}`);
    const before = client.metrics();
    let fallbackChunks = 0;
    try {
      const blocks = extractArticleTranslationBlocks(candidate.processedBody);
      if (!blocks.length) throw new Error("Article body has no translatable semantic blocks");
      const chunks = splitBlocks(candidate.title, blocks, maxChunkCharacters);
      const translated: TranslationPayload = { title: "", blocks: [] };
      const usedModels = new Set<string>();
      for (const chunk of chunks) {
        const prompt = translationPrompt(candidate.title, candidate.language, chunk);
        let payload: TranslationPayload;
        try {
          payload = parsePayload(await client.translate(primaryModel, prompt, deadlineAt), chunk);
          usedModels.add(primaryModel);
        } catch (primaryError) {
          fallbackChunks += 1;
          options.onProgress?.(`[translation] fallback ${candidate.articleId}: ${primaryError instanceof Error ? primaryError.message : String(primaryError)}`);
          payload = parsePayload(await client.translate(fallbackModel, prompt, deadlineAt), chunk);
          usedModels.add(fallbackModel);
        }
        if (!translated.title) translated.title = payload.title;
        translated.blocks.push(...payload.blocks);
      }
      const stored: StoredTranslation = {
        formatVersion: TRANSLATION_FORMAT,
        policy: TIMES_TRANSLATION_POLICY,
        articleId: candidate.articleId,
        language: TARGET_LANGUAGE,
        sourceLanguage: candidate.language,
        title: translated.title,
        body: {
          format: "html",
          profile: "jojo-semantic-html/1",
          value: applyArticleTranslation(candidate.processedBody, translated.blocks),
        },
        provider: "google-gemini-api",
        model: [...usedModels].join("+"),
        translatedAt: now().toISOString(),
        sourceHash: hash,
      };
      await writeCachedTranslation(output, cacheObject, stored);
      const after = client.metrics();
      return {
        candidate: { ...candidate, translation: stored, translationCacheObject: cacheObject, translationStatus: "translated" },
        status: "translated",
        requests: after.requests - before.requests,
        fallbackChunks,
        promptTokens: after.promptTokens - before.promptTokens,
        outputTokens: after.outputTokens - before.outputTokens,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const after = client.metrics();
      options.onProgress?.(`[translation] failed ${candidate.articleId}: ${message}`);
      return {
        candidate: { ...candidate, translationStatus: "failed", translationError: message },
        status: "failed",
        requests: after.requests - before.requests,
        fallbackChunks,
        promptTokens: after.promptTokens - before.promptTokens,
        outputTokens: after.outputTokens - before.outputTokens,
        failure: { articleId: candidate.articleId, sourceId: candidate.sourceId, title: candidate.title, error: message },
      };
    }
  });

  const metrics = client.metrics();
  return {
    candidates: rows.map((row) => row.candidate),
    stats: {
      eligible: rows.filter((row) => row.status !== "not-required").length,
      translated: rows.filter((row) => row.status === "translated").length,
      cacheHits: rows.filter((row) => row.status === "cached").length,
      failed: rows.filter((row) => row.status === "failed").length,
      notRequired: rows.filter((row) => row.status === "not-required").length,
      requests: metrics.requests,
      fallbackChunks: rows.reduce((sum, row) => sum + row.fallbackChunks, 0),
      promptTokens: metrics.promptTokens,
      outputTokens: metrics.outputTokens,
      durationMs: Date.now() - started,
      failures: rows.flatMap((row) => row.failure ? [row.failure] : []),
    },
  };
}
