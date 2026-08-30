import { gzipSync, gunzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { load, type CheerioAPI } from "cheerio";
import { sha256 } from "../identity.js";
import type { ProcessedArticleTranslation, ProcessedCandidate } from "../process/article.js";
import { normalizeGeminiApiKeys } from "./api-keys.js";

const TRANSLATION_FORMAT = "jojo-times-translation/1" as const;
const TRANSLATION_FAILURE_FORMAT = "jojo-times-translation-failure/1" as const;
export const TIMES_TRANSLATION_POLICY = "gemma-news-zh-v1" as const;
export const TIMES_TRANSLATION_DEFAULTS = {
  workers: 8,
  requestTimeoutMs: 240_000,
  batchTimeoutMs: 720_000,
  maxChunkCharacters: 20_000,
  requestsPerMinute: 28,
  tokensPerMinute: 14_000,
} as const;
const TARGET_LANGUAGE = "zh-CN" as const;
const BLOCK_SELECTOR = "p,h1,h2,h3,h4,blockquote,figcaption,li,td,th";

interface InlineNode {
  type: string;
  data?: string;
  children?: InlineNode[];
}

interface TranslationSegment {
  id: string;
  text: string;
}

interface TranslationBlock {
  id: string;
  tag: string;
  segments: TranslationSegment[];
}

interface TranslationPayload {
  title: string;
  blocks: Array<{ id: string; segments: TranslationSegment[] }>;
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

interface StoredTranslationFailure {
  formatVersion: typeof TRANSLATION_FAILURE_FORMAT;
  policy: typeof TIMES_TRANSLATION_POLICY;
  articleId: string;
  sourceHash: string;
  failedAt: string;
  retryAfter: string;
  attempts: number;
  error: string;
}

type TranslationCacheEntry = StoredTranslation | StoredTranslationFailure;

export interface GemmaTranslationOptions {
  apiKey?: string;
  apiKeys?: readonly string[];
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
  deferred: number;
  notRequired: number;
  requests: number;
  fallbackChunks: number;
  promptTokens: number;
  outputTokens: number;
  configuredProjects: number;
  quotaKeySwitches: number;
  durationMs: number;
  failures: TranslationFailure[];
}

export interface TranslationBatchResult {
  candidates: ProcessedCandidate[];
  stats: TranslationBatchStats;
}

interface ArticleTranslationResult {
  candidate: ProcessedCandidate;
  status: "translated" | "cached" | "failed" | "deferred" | "not-required";
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

class GeminiHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "GeminiHttpError";
  }
}

interface GemmaProjectSlot {
  apiKey: string;
  limiters: Map<string, MinuteRateLimiter>;
}

interface GemmaClientOptions {
  apiKeys: readonly string[];
  requestTimeoutMs: number;
  requestsPerMinute: number;
  tokensPerMinute: number;
  fetchImpl: typeof fetch;
  onProgress: ((message: string) => void) | undefined;
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

function translatableTextNodes(document: CheerioAPI, element: ReturnType<CheerioAPI>[number]): InlineNode[] {
  const nodes: InlineNode[] = [];
  const visit = (node: InlineNode): void => {
    if (node.type === "text") {
      if ((node.data ?? "").replace(/\s+/gu, " ").trim()) nodes.push(node);
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  for (const node of document(element).contents().toArray()) visit(node as InlineNode);
  return nodes;
}

export function extractArticleTranslationBlocks(body: string): TranslationBlock[] {
  const document = load(body, undefined, false);
  return leafBlockElements(document).map((element, index) => ({
    id: `b${index + 1}`,
    tag: String(document(element).prop("tagName") ?? "p").toLowerCase(),
    segments: translatableTextNodes(document, element).map((node, segmentIndex) => ({
      id: `s${segmentIndex + 1}`,
      text: (node.data ?? "").replace(/\s+/gu, " ").trim(),
    })),
  }));
}

export function applyArticleTranslation(body: string, blocks: TranslationPayload["blocks"]): string {
  const document = load(body, undefined, false);
  const elements = leafBlockElements(document);
  const expected = extractArticleTranslationBlocks(body);
  if (elements.length !== blocks.length || elements.some((_element, index) => blocks[index]?.id !== expected[index]?.id)) {
    throw new Error(`Translated block structure mismatch: expected ${elements.length}, received ${blocks.length}`);
  }
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index]!;
    const nodes = translatableTextNodes(document, element);
    const translatedSegments = blocks[index]!.segments;
    const expectedSegments = expected[index]!.segments;
    if (translatedSegments.length !== nodes.length || translatedSegments.some((segment, segmentIndex) => (
      segment.id !== expectedSegments[segmentIndex]?.id || typeof segment.text !== "string" || !segment.text.trim()
    ))) {
      throw new Error(`Translated segment structure mismatch for ${expected[index]!.id}: expected ${nodes.length}, received ${translatedSegments.length}`);
    }
    for (let segmentIndex = 0; segmentIndex < nodes.length; segmentIndex += 1) {
      nodes[segmentIndex]!.data = translatedSegments[segmentIndex]!.text.trim();
    }
  }
  return document.html().trim();
}

function splitBlocks(title: string, blocks: TranslationBlock[], maxCharacters: number): TranslationBlock[][] {
  if (!blocks.length) return [[]];
  const chunks: TranslationBlock[][] = [];
  let current: TranslationBlock[] = [];
  let characters = title.length;
  for (const block of blocks) {
    const blockCharacters = block.segments.reduce((sum, segment) => sum + segment.text.length, 0);
    if (current.length > 0 && characters + blockCharacters > maxCharacters) {
      chunks.push(current);
      current = [];
      characters = title.length;
    }
    current.push(block);
    characters += blockCharacters;
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
    "3. Keep every block id, segment id, and their order exactly. Return one translated segment for every input segment.",
    "4. Each segment is a text node inside publisher-controlled HTML. Translate only its text; never add, remove, merge, or move segments.",
    "5. Preserve email addresses, URLs, author names, and identifiers when they should not be translated.",
    "6. Output JSON only: {\"title\":\"...\",\"blocks\":[{\"id\":\"b1\",\"segments\":[{\"id\":\"s1\",\"text\":\"...\"}]}]}",
    "INPUT:",
    JSON.stringify({ title, blocks: blocks.map(({ id, segments }) => ({ id, segments })) }),
  ].join("\n");
}

function parsePayload(value: string, expected: TranslationBlock[]): TranslationPayload {
  const text = value.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  const parsed = JSON.parse(text) as Partial<TranslationPayload>;
  if (typeof parsed.title !== "string" || !parsed.title.trim() || !Array.isArray(parsed.blocks)) {
    throw new Error("Gemma returned an invalid translation payload");
  }
  if (parsed.blocks.length !== expected.length || parsed.blocks.some((block, index) => {
    const expectedBlock = expected[index];
    return !block || block.id !== expectedBlock?.id || !Array.isArray(block.segments)
      || block.segments.length !== expectedBlock.segments.length
      || block.segments.some((segment, segmentIndex) => (
        !segment || segment.id !== expectedBlock.segments[segmentIndex]?.id
        || typeof segment.text !== "string" || !segment.text.trim()
      ));
  })) {
    throw new Error(`Gemma returned invalid block structure: expected ${expected.length}, received ${parsed.blocks.length}`);
  }
  return {
    title: parsed.title.trim(),
    blocks: parsed.blocks.map((block) => ({
      id: block.id,
      segments: block.segments.map((segment) => ({ id: segment.id, text: segment.text.trim() })),
    })),
  };
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

export function translationSourceHash(candidate: Pick<ProcessedCandidate, "language" | "title" | "processedBody">): string {
  return sha256(JSON.stringify({
    policy: TIMES_TRANSLATION_POLICY,
    language: candidate.language,
    title: candidate.title,
    body: candidate.processedBody,
  }));
}

async function cachedEntry(output: string, objectName: string, expectedHash: string): Promise<TranslationCacheEntry | undefined> {
  try {
    const parsed = JSON.parse(gunzipSync(await readFile(safeCachePath(output, objectName))).toString("utf8")) as TranslationCacheEntry;
    if (parsed.policy !== TIMES_TRANSLATION_POLICY || parsed.sourceHash !== expectedHash) return undefined;
    if (parsed.formatVersion === TRANSLATION_FORMAT) {
      if (parsed.language !== TARGET_LANGUAGE || typeof parsed.title !== "string" || typeof parsed.body?.value !== "string") return undefined;
      return parsed;
    }
    if (parsed.formatVersion === TRANSLATION_FAILURE_FORMAT && Number.isInteger(parsed.attempts) && parsed.attempts > 0
      && typeof parsed.failedAt === "string" && typeof parsed.retryAfter === "string" && typeof parsed.error === "string") {
      return parsed;
    }
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeCacheEntry(output: string, objectName: string, entry: TranslationCacheEntry): Promise<void> {
  const target = safeCachePath(output, objectName);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, gzipSync(`${JSON.stringify(entry)}\n`, { level: 9 }));
}

function failureRetryDelayMs(attempts: number): number {
  return Math.min(30 * 60_000 * 2 ** Math.max(0, attempts - 1), 6 * 60 * 60_000);
}

class GemmaClient {
  private readonly projects: GemmaProjectSlot[];
  private readonly modelCursors = new Map<string, number>();
  private requestCount = 0;
  private promptTokenCount = 0;
  private outputTokenCount = 0;
  private quotaKeySwitchCount = 0;

  constructor(private readonly options: GemmaClientOptions) {
    this.projects = options.apiKeys.map((apiKey) => ({ apiKey, limiters: new Map() }));
  }

  metrics(): { requests: number; promptTokens: number; outputTokens: number; quotaKeySwitches: number } {
    return {
      requests: this.requestCount,
      promptTokens: this.promptTokenCount,
      outputTokens: this.outputTokenCount,
      quotaKeySwitches: this.quotaKeySwitchCount,
    };
  }

  private limiter(project: GemmaProjectSlot, model: string): MinuteRateLimiter {
    let limiter = project.limiters.get(model);
    if (!limiter) {
      limiter = new MinuteRateLimiter(this.options.requestsPerMinute, this.options.tokensPerMinute);
      project.limiters.set(model, limiter);
    }
    return limiter;
  }

  private async translateWithProject(project: GemmaProjectSlot, model: string, prompt: string, deadlineAt: number): Promise<string> {
    if (Date.now() >= deadlineAt) throw new Error("Translation batch deadline exceeded");
    const event = await this.limiter(project, model).acquire(estimatedPromptTokens(prompt), deadlineAt);
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) throw new Error("Translation batch deadline exceeded");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(this.options.requestTimeoutMs, remainingMs));
    this.requestCount += 1;
    try {
      const response = await this.options.fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": project.apiKey },
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
      if (!response.ok) throw new GeminiHttpError(response.status, payload.error?.message ?? `Gemini returned HTTP ${response.status}`);
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

  async translate(model: string, prompt: string, deadlineAt: number): Promise<string> {
    const start = this.modelCursors.get(model) ?? 0;
    this.modelCursors.set(model, (start + 1) % this.projects.length);
    let lastQuotaError: GeminiHttpError | undefined;
    for (let offset = 0; offset < this.projects.length; offset += 1) {
      const projectIndex = (start + offset) % this.projects.length;
      try {
        return await this.translateWithProject(this.projects[projectIndex]!, model, prompt, deadlineAt);
      } catch (error) {
        if (!(error instanceof GeminiHttpError) || error.status !== 429) throw error;
        lastQuotaError = error;
        if (offset + 1 >= this.projects.length) break;
        this.quotaKeySwitchCount += 1;
        const nextProject = (projectIndex + 1) % this.projects.length;
        this.options.onProgress?.(
          `[translation] ${model} project ${projectIndex + 1}/${this.projects.length} returned 429; retrying project ${nextProject + 1}/${this.projects.length}`,
        );
      }
    }
    throw lastQuotaError ?? new Error("Gemini translation has no configured API project");
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
  const apiKeys = normalizeGeminiApiKeys(options.apiKeys, options.apiKey);
  if (apiKeys.length === 0) throw new Error("Gemma translation requires at least one non-empty API key");
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
    apiKeys,
    requestTimeoutMs,
    requestsPerMinute,
    tokensPerMinute,
    fetchImpl: options.fetchImpl ?? fetch,
    onProgress: options.onProgress,
  });
  const started = Date.now();
  const deadlineAt = started + batchTimeoutMs;

  const rows = await mapLimit(candidates, workers, async (candidate, index): Promise<ArticleTranslationResult> => {
    if (!candidate.processedBody || candidate.contentStatus !== "full" || chineseLanguage(candidate.language)) {
      return { candidate, status: "not-required", requests: 0, fallbackChunks: 0, promptTokens: 0, outputTokens: 0 };
    }
    const hash = translationSourceHash(candidate);
    const cacheObject = translationCacheObject(candidate, hash);
    let cached: TranslationCacheEntry | undefined;
    try {
      cached = await cachedEntry(output, cacheObject, hash);
    } catch (error) {
      options.onProgress?.(`[translation] ignoring invalid cache ${cacheObject}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (cached?.formatVersion === TRANSLATION_FORMAT) {
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
    if (cached?.formatVersion === TRANSLATION_FAILURE_FORMAT && new Date(cached.retryAfter).getTime() > now().getTime()) {
      options.onProgress?.(`[translation] deferred ${candidate.articleId} until ${cached.retryAfter}: ${cached.error}`);
      return {
        candidate: {
          ...candidate,
          translationCacheObject: cacheObject,
          translationStatus: "deferred",
          translationError: cached.error,
        },
        status: "deferred",
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
      await writeCacheEntry(output, cacheObject, stored);
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
      const failedAt = now();
      const attempts = cached?.formatVersion === TRANSLATION_FAILURE_FORMAT ? cached.attempts + 1 : 1;
      const failure: StoredTranslationFailure = {
        formatVersion: TRANSLATION_FAILURE_FORMAT,
        policy: TIMES_TRANSLATION_POLICY,
        articleId: candidate.articleId,
        sourceHash: hash,
        failedAt: failedAt.toISOString(),
        retryAfter: new Date(failedAt.getTime() + failureRetryDelayMs(attempts)).toISOString(),
        attempts,
        error: message,
      };
      await writeCacheEntry(output, cacheObject, failure);
      return {
        candidate: { ...candidate, translationCacheObject: cacheObject, translationStatus: "failed", translationError: message },
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
      deferred: rows.filter((row) => row.status === "deferred").length,
      notRequired: rows.filter((row) => row.status === "not-required").length,
      requests: metrics.requests,
      fallbackChunks: rows.reduce((sum, row) => sum + row.fallbackChunks, 0),
      promptTokens: metrics.promptTokens,
      outputTokens: metrics.outputTokens,
      configuredProjects: apiKeys.length,
      quotaKeySwitches: metrics.quotaKeySwitches,
      durationMs: Date.now() - started,
      failures: rows.flatMap((row) => row.failure ? [row.failure] : []),
    },
  };
}
