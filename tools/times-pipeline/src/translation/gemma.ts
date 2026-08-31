import { gzipSync, gunzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { load, type CheerioAPI } from "cheerio";
import { sha256 } from "../identity.js";
import type { ProcessedArticleTranslation, ProcessedCandidate } from "../process/article.js";
import { normalizeGeminiApiKeys } from "./api-keys.js";

const TRANSLATION_FORMAT = "jojo-times-translation/1" as const;
const TRANSLATION_FAILURE_FORMAT = "jojo-times-translation-failure/1" as const;
export const TIMES_TRANSLATION_POLICY = "gemma-news-zh-v2" as const;
export const TIMES_TRANSLATION_DEFAULTS = {
  workers: 8,
  requestTimeoutMs: 240_000,
  batchTimeoutMs: 1_440_000,
  maxChunkCharacters: 20_000,
  requestsPerMinute: 28,
  tokensPerMinute: 14_000,
} as const;
const TARGET_LANGUAGE = "zh-CN" as const;
const BLOCK_SELECTOR = "p,h1,h2,h3,h4,blockquote,figcaption,li,td,th";
const FLEXIBLE_FORMATTING_TAGS = new Set(["b", "em", "i", "s", "strong"]);

interface TranslationBlock {
  tag: string;
  html: string;
}

interface TranslationChunk {
  includesTitle: boolean;
  blocks: TranslationBlock[];
}

interface TranslatedChunk {
  title?: string;
  blocks: TranslationBlock[];
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

const TRANSLATION_BATCH_DEADLINE_MESSAGE = "Translation batch deadline exceeded";

class TranslationBatchDeadlineError extends Error {
  constructor(message = TRANSLATION_BATCH_DEADLINE_MESSAGE) {
    super(message);
    this.name = "TranslationBatchDeadlineError";
  }
}

function batchDeadlineFailure(message: string): boolean {
  return message.startsWith(TRANSLATION_BATCH_DEADLINE_MESSAGE);
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
  rescueModel?: string;
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
  deadlineDeferred: number;
  notRequired: number;
  requests: number;
  fallbackChunks: number;
  rescueChunks: number;
  promptTokens: number;
  outputTokens: number;
  configuredProjects: number;
  quotaKeySwitches: number;
  transientKeySwitches: number;
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
  rescueChunks: number;
  promptTokens: number;
  outputTokens: number;
  deadlineDeferred?: boolean;
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
      if (deadlineAt !== undefined && now + waitMs >= deadlineAt) {
        throw new TranslationBatchDeadlineError(`${TRANSLATION_BATCH_DEADLINE_MESSAGE} while rate limited`);
      }
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

class TranslationStructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranslationStructureError";
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

export function extractArticleTranslationBlocks(body: string): TranslationBlock[] {
  const document = load(body, undefined, false);
  return leafBlockElements(document).map((element) => ({
    tag: String(document(element).prop("tagName") ?? "p").toLowerCase(),
    html: document.html(element),
  }));
}

function attributes(document: CheerioAPI, element: ReturnType<CheerioAPI>[number]): Record<string, string> {
  return document(element).attr() ?? {};
}

function elementSignature(document: CheerioAPI, element: ReturnType<CheerioAPI>[number]): string {
  const tag = String(document(element).prop("tagName") ?? "").toLowerCase();
  const serializedAttributes = Object.entries(attributes(document, element))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join("|");
  return `${tag}[${serializedAttributes}]`;
}

function signatureCounts(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function firstSignatureDifference(expected: readonly string[], actual: readonly string[]): string | undefined {
  const expectedCounts = signatureCounts(expected);
  const actualCounts = signatureCounts(actual);
  for (const signature of new Set([...expectedCounts.keys(), ...actualCounts.keys()])) {
    const expectedCount = expectedCounts.get(signature) ?? 0;
    const actualCount = actualCounts.get(signature) ?? 0;
    if (expectedCount !== actualCount) return `${signature} expected ${expectedCount}, received ${actualCount}`;
  }
  return undefined;
}

function plainFormattingCounts(document: CheerioAPI, element: ReturnType<CheerioAPI>[number]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const child of document(element).find("*").toArray()) {
    const tag = String(document(child).prop("tagName") ?? "").toLowerCase();
    if (!FLEXIBLE_FORMATTING_TAGS.has(tag) || Object.keys(attributes(document, child)).length > 0) continue;
    counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return counts;
}

function normalizeAddedFlexibleFormatting(
  sourceDocument: CheerioAPI,
  sourceElement: ReturnType<CheerioAPI>[number],
  translatedDocument: CheerioAPI,
  translatedElement: ReturnType<CheerioAPI>[number],
): void {
  const sourceFormatting = plainFormattingCounts(sourceDocument, sourceElement);
  for (const child of translatedDocument(translatedElement).find("*").toArray().reverse()) {
    const tag = String(translatedDocument(child).prop("tagName") ?? "").toLowerCase();
    if (!FLEXIBLE_FORMATTING_TAGS.has(tag) || Object.keys(attributes(translatedDocument, child)).length > 0) continue;
    if ((sourceFormatting.get(tag) ?? 0) === 0) translatedDocument(child).replaceWith(translatedDocument(child).contents());
  }
}

function validateTranslatedBlock(
  sourceDocument: CheerioAPI,
  sourceElement: ReturnType<CheerioAPI>[number],
  translatedDocument: CheerioAPI,
  translatedElement: ReturnType<CheerioAPI>[number],
  index: number,
): void {
  normalizeAddedFlexibleFormatting(sourceDocument, sourceElement, translatedDocument, translatedElement);
  if (elementSignature(sourceDocument, sourceElement) !== elementSignature(translatedDocument, translatedElement)) {
    throw new TranslationStructureError(`Translated block ${index} changed its outer tag or attributes`);
  }
  if (!translatedDocument(translatedElement).text().replace(/\s+/gu, " ").trim()) {
    throw new TranslationStructureError(`Translated block ${index} is empty`);
  }

  const protectedSignatures = (
    document: CheerioAPI,
    element: ReturnType<CheerioAPI>[number],
  ): string[] => document(element).find("*").toArray().flatMap((child) => {
    const tag = String(document(child).prop("tagName") ?? "").toLowerCase();
    const flexible = FLEXIBLE_FORMATTING_TAGS.has(tag) && Object.keys(attributes(document, child)).length === 0;
    return flexible ? [] : [elementSignature(document, child)];
  });
  const protectedDifference = firstSignatureDifference(
    protectedSignatures(sourceDocument, sourceElement),
    protectedSignatures(translatedDocument, translatedElement),
  );
  if (protectedDifference) throw new TranslationStructureError(`Translated block ${index} changed protected HTML: ${protectedDifference}`);
}

function singleRootElement(html: string, label: string): { document: CheerioAPI; element: ReturnType<CheerioAPI>[number] } {
  const document = load(html, undefined, false);
  const elements = document.root().children().toArray();
  const elementNodes = new Set<unknown>(elements);
  const hasOtherContent = document.root().contents().toArray().some((node) => {
    if (elementNodes.has(node)) return false;
    return node.type !== "text" || ((node as { data?: string }).data ?? "").trim().length > 0;
  });
  if (elements.length !== 1 || hasOtherContent) throw new Error(`${label} must contain exactly one root HTML element`);
  return { document, element: elements[0]! };
}

export function applyArticleTranslation(body: string, blocks: TranslationBlock[]): string {
  const sourceDocument = load(body, undefined, false);
  const sourceElements = leafBlockElements(sourceDocument);
  if (sourceElements.length !== blocks.length) {
    throw new Error(`Translated block structure mismatch: expected ${sourceElements.length}, received ${blocks.length}`);
  }
  for (let index = 0; index < sourceElements.length; index += 1) {
    const sourceElement = sourceElements[index]!;
    const translatedBlock = blocks[index]!;
    const translated = singleRootElement(translatedBlock.html, `Translated block ${index + 1}`);
    if (translatedBlock.tag !== String(translated.document(translated.element).prop("tagName") ?? "").toLowerCase()) {
      throw new Error(`Translated block ${index + 1} tag metadata does not match its HTML`);
    }
    validateTranslatedBlock(sourceDocument, sourceElement, translated.document, translated.element, index + 1);
    sourceDocument(sourceElement).html(translated.document(translated.element).html() ?? "");
  }
  return sourceDocument.html().trim();
}

function splitBlocks(title: string, blocks: TranslationBlock[], maxCharacters: number): TranslationChunk[] {
  const chunks: TranslationChunk[] = [];
  let current: TranslationBlock[] = [];
  let characters = title.length;
  for (const block of blocks) {
    const blockCharacters = block.html.length;
    if (current.length > 0 && characters + blockCharacters > maxCharacters) {
      chunks.push({ includesTitle: chunks.length === 0, blocks: current });
      current = [];
      characters = 0;
    }
    current.push(block);
    characters += blockCharacters;
  }
  if (current.length > 0) chunks.push({ includesTitle: chunks.length === 0, blocks: current });
  return chunks;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function translationPrompt(title: string, sourceLanguage: string, chunk: TranslationChunk): string {
  const html = [
    ...(chunk.includesTitle ? [`<h1>${escapeHtml(title)}</h1>`] : []),
    ...chunk.blocks.map((block) => block.html),
  ].join("\n");
  return [
    `Translate the following complete HTML news blocks from ${sourceLanguage} into accurate, natural Simplified Chinese.`,
    "Rules:",
    "1. Translate all visible source-language text completely. Do not summarize, omit, merge, add, explain, or fact-check.",
    "2. Preserve meaning, uncertainty, tone, quotations, names, numbers, dates, currencies, units, and acronyms.",
    "3. Keep every block and its block-level tag in the original order. Preserve every HTML attribute exactly.",
    "4. Preserve links and visual formatting. A complete inline element may move within its own block for natural Chinese word order, but never change which text it describes.",
    "5. Preserve email addresses, URLs, author names, and identifiers when they should not be translated.",
    "6. Return only the translated HTML fragment, with no JSON, Markdown fence, or explanation.",
    "HTML:",
    html,
  ].join("\n");
}

function parseTranslatedChunk(value: string, expected: TranslationChunk): TranslatedChunk {
  const text = value.trim().replace(/^```(?:html)?\s*/iu, "").replace(/\s*```$/u, "");
  const document = load(text, undefined, false);
  const elements = document.root().children().toArray();
  const elementNodes = new Set<unknown>(elements);
  const hasOtherContent = document.root().contents().toArray().some((node) => {
    if (elementNodes.has(node)) return false;
    return node.type !== "text" || ((node as { data?: string }).data ?? "").trim().length > 0;
  });
  const expectedCount = expected.blocks.length + (expected.includesTitle ? 1 : 0);
  if (hasOtherContent || elements.length !== expectedCount) {
    throw new TranslationStructureError(`Gemma returned invalid HTML block structure: expected ${expectedCount}, received ${elements.length}`);
  }

  let offset = 0;
  let translatedTitle: string | undefined;
  if (expected.includesTitle) {
    const titleElement = elements[0]!;
    const titleTag = String(document(titleElement).prop("tagName") ?? "").toLowerCase();
    if (titleTag !== "h1" || document(titleElement).find("*").length > 0) {
      throw new TranslationStructureError("Gemma changed the title HTML structure");
    }
    translatedTitle = document(titleElement).text().replace(/\s+/gu, " ").trim();
    if (!translatedTitle) throw new TranslationStructureError("Gemma returned an empty translated title");
    offset = 1;
  }

  const blocks = expected.blocks.map((sourceBlock, index) => {
    const translatedElement = elements[index + offset]!;
    const source = singleRootElement(sourceBlock.html, `Source block ${index + 1}`);
    validateTranslatedBlock(source.document, source.element, document, translatedElement, index + 1);
    return {
      tag: String(document(translatedElement).prop("tagName") ?? "").toLowerCase(),
      html: document.html(translatedElement),
    };
  });
  return {
    ...(translatedTitle ? { title: translatedTitle } : {}),
    blocks,
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
  private transientKeySwitchCount = 0;

  constructor(private readonly options: GemmaClientOptions) {
    this.projects = options.apiKeys.map((apiKey) => ({ apiKey, limiters: new Map() }));
  }

  metrics(): {
    requests: number;
    promptTokens: number;
    outputTokens: number;
    quotaKeySwitches: number;
    transientKeySwitches: number;
  } {
    return {
      requests: this.requestCount,
      promptTokens: this.promptTokenCount,
      outputTokens: this.outputTokenCount,
      quotaKeySwitches: this.quotaKeySwitchCount,
      transientKeySwitches: this.transientKeySwitchCount,
    };
  }

  private limiter(project: GemmaProjectSlot, model: string): MinuteRateLimiter {
    let limiter = project.limiters.get(model);
    if (!limiter) {
      const requestsPerMinute = model.startsWith("gemini-")
        ? Math.min(this.options.requestsPerMinute, 5)
        : this.options.requestsPerMinute;
      limiter = new MinuteRateLimiter(requestsPerMinute, this.options.tokensPerMinute);
      project.limiters.set(model, limiter);
    }
    return limiter;
  }

  private async translateWithProject(project: GemmaProjectSlot, model: string, prompt: string, deadlineAt: number): Promise<string> {
    if (Date.now() >= deadlineAt) throw new TranslationBatchDeadlineError();
    const event = await this.limiter(project, model).acquire(estimatedPromptTokens(prompt), deadlineAt);
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) throw new TranslationBatchDeadlineError();
    const controller = new AbortController();
    const deadlineControlsTimeout = remainingMs <= this.options.requestTimeoutMs;
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
            thinkingConfig: { thinkingLevel: model.startsWith("gemini-") ? "low" : "minimal" },
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
    } catch (error) {
      if (deadlineControlsTimeout && controller.signal.aborted) throw new TranslationBatchDeadlineError();
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async translate(model: string, prompt: string, deadlineAt: number): Promise<string> {
    const start = this.modelCursors.get(model) ?? 0;
    this.modelCursors.set(model, (start + 1) % this.projects.length);
    let lastRetryableError: GeminiHttpError | undefined;
    for (let offset = 0; offset < this.projects.length; offset += 1) {
      const projectIndex = (start + offset) % this.projects.length;
      try {
        return await this.translateWithProject(this.projects[projectIndex]!, model, prompt, deadlineAt);
      } catch (error) {
        if (!(error instanceof GeminiHttpError) || ![429, 500, 502, 503, 504].includes(error.status)) throw error;
        lastRetryableError = error;
        if (offset + 1 >= this.projects.length) break;
        if (error.status === 429) this.quotaKeySwitchCount += 1;
        else this.transientKeySwitchCount += 1;
        const nextProject = (projectIndex + 1) % this.projects.length;
        this.options.onProgress?.(
          `[translation] ${model} project ${projectIndex + 1}/${this.projects.length} returned ${error.status}; retrying project ${nextProject + 1}/${this.projects.length}`,
        );
      }
    }
    throw lastRetryableError ?? new Error("Gemini translation has no configured API project");
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
  const rescueModel = options.rescueModel?.trim() || "gemini-3.5-flash";
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
      return { candidate, status: "not-required", requests: 0, fallbackChunks: 0, rescueChunks: 0, promptTokens: 0, outputTokens: 0 };
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
        rescueChunks: 0,
        promptTokens: 0,
        outputTokens: 0,
      };
    }
    if (
      cached?.formatVersion === TRANSLATION_FAILURE_FORMAT
      && !batchDeadlineFailure(cached.error)
      && new Date(cached.retryAfter).getTime() > now().getTime()
    ) {
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
        rescueChunks: 0,
        promptTokens: 0,
        outputTokens: 0,
      };
    }
    const before = client.metrics();
    const deferForBatchDeadline = (message: string, fallbackChunks = 0, rescueChunks = 0): ArticleTranslationResult => {
      const after = client.metrics();
      options.onProgress?.(`[translation] deferred ${candidate.articleId} to the next Process run: ${message}`);
      return {
        candidate: {
          ...candidate,
          translationCacheObject: cacheObject,
          translationStatus: "deferred",
          translationError: message,
        },
        status: "deferred",
        requests: after.requests - before.requests,
        fallbackChunks,
        rescueChunks,
        promptTokens: after.promptTokens - before.promptTokens,
        outputTokens: after.outputTokens - before.outputTokens,
        deadlineDeferred: true,
      };
    };
    if (Date.now() >= deadlineAt) return deferForBatchDeadline(TRANSLATION_BATCH_DEADLINE_MESSAGE);
    if (cached?.formatVersion === TRANSLATION_FAILURE_FORMAT && batchDeadlineFailure(cached.error)) {
      options.onProgress?.(`[translation] retrying ${candidate.articleId} immediately after an earlier batch deadline`);
    }
    options.onProgress?.(`[translation] ${index + 1}/${candidates.length} ${candidate.sourceId} ${candidate.title.slice(0, 80)}`);
    let fallbackChunks = 0;
    let rescueChunks = 0;
    try {
      const blocks = extractArticleTranslationBlocks(candidate.processedBody);
      if (!blocks.length) throw new Error("Article body has no translatable semantic blocks");
      const chunks = splitBlocks(candidate.title, blocks, maxChunkCharacters);
      const translated: TranslatedChunk = { blocks: [] };
      const usedModels = new Set<string>();
      const translateChunk = async (chunk: TranslationChunk): Promise<TranslatedChunk> => {
        const prompt = translationPrompt(candidate.title, candidate.language, chunk);
        try {
          const payload = parseTranslatedChunk(await client.translate(primaryModel, prompt, deadlineAt), chunk);
          usedModels.add(primaryModel);
          return payload;
        } catch (primaryError) {
          if (primaryError instanceof TranslationBatchDeadlineError) throw primaryError;
          fallbackChunks += 1;
          options.onProgress?.(`[translation] fallback ${candidate.articleId}: ${primaryError instanceof Error ? primaryError.message : String(primaryError)}`);
          try {
            const payload = parseTranslatedChunk(await client.translate(fallbackModel, prompt, deadlineAt), chunk);
            usedModels.add(fallbackModel);
            return payload;
          } catch (fallbackError) {
            if (fallbackError instanceof TranslationBatchDeadlineError) throw fallbackError;
            const structuralError = fallbackError instanceof TranslationStructureError
              ? fallbackError
              : primaryError instanceof TranslationStructureError ? primaryError : undefined;
            if (!structuralError) throw fallbackError;

            rescueChunks += 1;
            options.onProgress?.(`[translation] structural rescue ${candidate.articleId} with ${rescueModel}: ${structuralError.message}`);
            const payload = parseTranslatedChunk(await client.translate(rescueModel, prompt, deadlineAt), chunk);
            usedModels.add(rescueModel);
            return payload;
          }
        }
      };
      for (const chunk of chunks) {
        const payload = await translateChunk(chunk);
        if (!translated.title && payload.title) translated.title = payload.title;
        translated.blocks.push(...payload.blocks);
      }
      if (!translated.title) throw new Error("Gemma returned no translated title");
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
        rescueChunks,
        promptTokens: after.promptTokens - before.promptTokens,
        outputTokens: after.outputTokens - before.outputTokens,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof TranslationBatchDeadlineError || Date.now() >= deadlineAt) {
        return deferForBatchDeadline(message, fallbackChunks, rescueChunks);
      }
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
        rescueChunks,
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
      deadlineDeferred: rows.filter((row) => row.deadlineDeferred).length,
      notRequired: rows.filter((row) => row.status === "not-required").length,
      requests: metrics.requests,
      fallbackChunks: rows.reduce((sum, row) => sum + row.fallbackChunks, 0),
      rescueChunks: rows.reduce((sum, row) => sum + row.rescueChunks, 0),
      promptTokens: metrics.promptTokens,
      outputTokens: metrics.outputTokens,
      configuredProjects: apiKeys.length,
      quotaKeySwitches: metrics.quotaKeySwitches,
      transientKeySwitches: metrics.transientKeySwitches,
      durationMs: Date.now() - started,
      failures: rows.flatMap((row) => row.failure ? [row.failure] : []),
    },
  };
}
