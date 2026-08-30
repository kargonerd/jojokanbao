import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import type { JojoFragment, TimesDeliveryArticle, TimesTimelineDay, TimesTimelineIndex } from "@jojo/content";
import { readJoxJson } from "../delivery-writer.js";
import { TIMES_TRANSLATION_DEFAULTS } from "./gemma.js";

export interface TranslationBlock {
  id: string;
  tag: string;
  text: string;
}

export interface BenchmarkArticle {
  id: string;
  title: string;
  sourceId: string;
  sourceName: string;
  url?: string;
  publishedAt: string;
  articleObject: string;
  blocks: TranslationBlock[];
  bodyCharacters: number;
  complexity: number;
}

export interface TranslationPayload {
  title: string;
  blocks: Array<{ id: string; text: string }>;
}

export interface TranslationValidation {
  validStructure: boolean;
  titlePresent: boolean;
  expectedBlocks: number;
  returnedBlocks: number;
  exactBlockIds: boolean;
  nonEmptyBlocks: number;
  numericRecall: number;
  cjkRatio: number;
  suspiciouslyShortBlocks: number;
  untranslatedBlocks: number;
}

export interface TranslationResult {
  articleId: string;
  model: string;
  startedAt: string;
  latencyMs: number;
  promptTokens: number;
  outputTokens: number;
  attempts: number;
  translation?: TranslationPayload;
  validation?: TranslationValidation;
  error?: string;
}

export interface JudgeAssessment {
  faithfulness: number;
  completeness: number;
  chineseQuality: number;
  terminology: number;
  criticalErrors: string[];
}

export interface JudgeResult {
  articleId: string;
  model: string;
  latencyMs: number;
  promptTokens: number;
  outputTokens: number;
  preferred: "A" | "B" | "tie";
  aModel: string;
  bModel: string;
  a: JudgeAssessment;
  b: JudgeAssessment;
  reason: string;
  error?: string;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  error?: { message?: string; code?: number; status?: string };
}

interface GeminiCallResult {
  text: string;
  latencyMs: number;
  promptTokens: number;
  outputTokens: number;
  attempts: number;
}

interface RateEvent {
  at: number;
  tokens: number;
}

const BLOCK_SELECTOR = "p,h1,h2,h3,h4,blockquote,figcaption,li,pre";

function normalizedObjectKey(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").includes("..")) throw new Error(`Unsafe object key: ${value}`);
  return normalized;
}

export function resolveObjectKey(parent: string, child: string): string {
  const resolved = new URL(child, new URL(normalizedObjectKey(parent), "https://jox.invalid/"));
  return normalizedObjectKey(decodeURIComponent(resolved.pathname));
}

export async function fetchJoxJson<T>(baseUrl: URL, objectKey: string): Promise<T> {
  const key = normalizedObjectKey(objectKey);
  const response = await fetch(new URL(key, baseUrl), { cache: "no-store" });
  if (!response.ok) throw new Error(`CDN returned HTTP ${response.status}: ${key}`);
  return readJoxJson<T>(new Uint8Array(await response.arrayBuffer()), key);
}

export function extractTranslationBlocks(html: string): TranslationBlock[] {
  const $ = load(html, undefined, false);
  const selected = $(BLOCK_SELECTOR).toArray().filter((element) => $(element).find(BLOCK_SELECTOR).length === 0);
  const blocks = selected.map((element, index) => ({
    id: `b${index + 1}`,
    tag: element.tagName.toLowerCase(),
    text: $(element).text().replace(/\s+/gu, " ").trim(),
  })).filter((block) => block.text.length > 0);
  if (blocks.length) return blocks.map((block, index) => ({ ...block, id: `b${index + 1}` }));
  const fallback = $.root().text().replace(/\s+/gu, " ").trim();
  return fallback ? [{ id: "b1", tag: "p", text: fallback }] : [];
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

async function mapLimit<T, R>(values: readonly T[], concurrency: number, task: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await task(values[index]!, index);
    }
  }));
  return results;
}

function variedByLength(articles: BenchmarkArticle[]): BenchmarkArticle[] {
  const sorted = [...articles].sort((left, right) => left.bodyCharacters - right.bodyCharacters || left.id.localeCompare(right.id));
  const result: BenchmarkArticle[] = [];
  let low = 0;
  let high = sorted.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidates = [sorted[middle], sorted[high], sorted[low]];
    for (const candidate of candidates) {
      if (candidate && !result.some((row) => row.id === candidate.id)) result.push(candidate);
    }
    low += 1;
    high -= 1;
  }
  return result;
}

export async function collectBenchmarkSample(input: {
  cdnBase: string;
  sampleSize: number;
  maximumDates?: number;
  candidatesPerSource?: number;
  onProgress?: (message: string) => void;
}): Promise<BenchmarkArticle[]> {
  const baseUrl = new URL(input.cdnBase.endsWith("/") ? input.cdnBase : `${input.cdnBase}/`);
  const timelineObject = "content/timeline/index.jox";
  const timeline = await fetchJoxJson<TimesTimelineIndex>(baseUrl, timelineObject);
  const englishSources = new Set(timeline.sources.filter((source) => !source.language.toLowerCase().startsWith("zh")).map((source) => source.id));
  const refs: TimesDeliveryArticle[] = [];
  const seen = new Set<string>();
  const maximumDates = input.maximumDates ?? 3;
  for (const dateRef of timeline.dates.slice(0, maximumDates)) {
    const object = resolveObjectKey(timelineObject, dateRef.object);
    const day = await fetchJoxJson<TimesTimelineDay>(baseUrl, object);
    for (const article of day.articles) {
      if (!englishSources.has(article.source.id) || seen.has(article.id)) continue;
      seen.add(article.id);
      refs.push(article);
    }
  }
  const grouped = new Map<string, TimesDeliveryArticle[]>();
  for (const ref of refs) grouped.set(ref.source.id, [...(grouped.get(ref.source.id) ?? []), ref]);
  const candidatesPerSource = input.candidatesPerSource ?? Math.max(14, Math.ceil(input.sampleSize * 2 / Math.max(grouped.size, 1)));
  const candidates = [...grouped.values()].flatMap((rows) => rows
    .toSorted((left, right) => stableHash(left.id) - stableHash(right.id))
    .slice(0, candidatesPerSource));
  input.onProgress?.(`Fetching ${candidates.length} candidate article bodies across ${grouped.size} English sources`);
  const fetched = await mapLimit(candidates, 12, async (article, index) => {
    if (index % 25 === 0) input.onProgress?.(`Fetched ${index}/${candidates.length} candidate bodies`);
    try {
      const fragment = await fetchJoxJson<JojoFragment>(baseUrl, article.articleObject);
      const blocks = extractTranslationBlocks(fragment.body.value);
      const bodyCharacters = blocks.reduce((total, block) => total + block.text.length, 0);
      const numberCount = (blocks.flatMap((block) => block.text.match(/\d+/gu) ?? [])).length;
      const complexity = bodyCharacters + blocks.length * 120 + numberCount * 40 + article.assets.length * 60;
      return {
        id: article.id,
        title: article.title,
        sourceId: article.source.id,
        sourceName: article.source.name,
        ...(article.url ? { url: article.url } : {}),
        publishedAt: article.publishedAt,
        articleObject: article.articleObject,
        blocks,
        bodyCharacters,
        complexity,
      } satisfies BenchmarkArticle;
    } catch (error) {
      input.onProgress?.(`${article.id}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  });
  const usable = fetched.filter((article): article is BenchmarkArticle => Boolean(article && article.bodyCharacters >= 250 && article.bodyCharacters <= 40_000));
  const bySource = new Map<string, BenchmarkArticle[]>();
  for (const article of usable) bySource.set(article.sourceId, [...(bySource.get(article.sourceId) ?? []), article]);
  const queues = [...bySource.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([sourceId, articles]) => ({ sourceId, articles: variedByLength(articles) }));
  const sample: BenchmarkArticle[] = [];
  let round = 0;
  while (sample.length < input.sampleSize) {
    let added = false;
    for (const queue of queues) {
      const article = queue.articles[round];
      if (!article) continue;
      sample.push(article);
      added = true;
      if (sample.length >= input.sampleSize) break;
    }
    if (!added) break;
    round += 1;
  }
  if (sample.length < input.sampleSize) throw new Error(`Only ${sample.length} usable English articles were available`);
  return sample;
}

export function buildTranslationPrompt(article: BenchmarkArticle): string {
  return [
    "You are a professional news translator. Translate the complete English news article into accurate, natural Simplified Chinese.",
    "Rules:",
    "1. Translate every title and block. Do not summarize, omit, merge, add, explain, or fact-check.",
    "2. Preserve meaning, uncertainty, tone, quotations, names, numbers, dates, currencies, units, and acronyms.",
    "3. Keep every block id and the original block order exactly. Return one translated block for every input block.",
    "4. Output JSON only with shape: {\"title\":\"...\",\"blocks\":[{\"id\":\"b1\",\"text\":\"...\"}]}",
    "INPUT:",
    JSON.stringify({ title: article.title, blocks: article.blocks.map(({ id, text }) => ({ id, text })) }),
  ].join("\n");
}

export function splitArticleForTranslation(
  article: BenchmarkArticle,
  maxCharacters: number = TIMES_TRANSLATION_DEFAULTS.maxChunkCharacters,
): BenchmarkArticle[] {
  if (maxCharacters < 1) throw new Error("maxCharacters must be positive");
  const groups: TranslationBlock[][] = [];
  let current: TranslationBlock[] = [];
  let characters = article.title.length;
  for (const block of article.blocks) {
    if (current.length > 0 && characters + block.text.length > maxCharacters) {
      groups.push(current);
      current = [];
      characters = article.title.length;
    }
    current.push(block);
    characters += block.text.length;
  }
  if (current.length > 0) groups.push(current);
  return groups.map((blocks) => ({
    ...article,
    blocks,
    bodyCharacters: blocks.reduce((sum, block) => sum + block.text.length, 0),
    complexity: blocks.reduce((sum, block) => sum + block.text.length + block.text.split(/\s+/u).length * 2, 0),
  }));
}

function parseJsonText<T>(value: string): T {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  return JSON.parse(trimmed) as T;
}

function numberTokens(value: string): string[] {
  return (value.match(/\d{1,2}:\d{2}|\d[\d,]*(?:\.\d+)?%?/gu) ?? [])
    .map((token) => token.replaceAll(",", ""));
}

function recall(expected: readonly string[], actual: readonly string[]): number {
  if (!expected.length) return 1;
  const remaining = [...actual];
  let found = 0;
  for (const token of expected) {
    const index = remaining.indexOf(token);
    if (index < 0) continue;
    remaining.splice(index, 1);
    found += 1;
  }
  return found / expected.length;
}

export function validateTranslation(article: BenchmarkArticle, translation: TranslationPayload): TranslationValidation {
  const expectedIds = article.blocks.map((block) => block.id);
  const returnedIds = Array.isArray(translation.blocks) ? translation.blocks.map((block) => block.id) : [];
  const exactBlockIds = expectedIds.length === returnedIds.length && expectedIds.every((id, index) => id === returnedIds[index]);
  const translatedText = [translation.title, ...(translation.blocks ?? []).map((block) => block.text)].join("\n");
  const sourceText = [article.title, ...article.blocks.map((block) => block.text)].join("\n");
  const cjk = translatedText.match(/[\p{Script=Han}]/gu)?.length ?? 0;
  const letters = translatedText.match(/[\p{L}]/gu)?.length ?? 0;
  const suspiciouslyShortBlocks = article.blocks.filter((block, index) => {
    const translated = translation.blocks?.[index]?.text?.trim() ?? "";
    return block.text.length >= 80 && translated.length < Math.max(8, block.text.length * 0.12);
  }).length;
  const untranslatedBlocks = (translation.blocks ?? []).filter((block) => {
    const han = block.text.match(/[\p{Script=Han}]/gu)?.length ?? 0;
    const latinWords = block.text.match(/[A-Za-z]{3,}/gu)?.length ?? 0;
    return block.text.length >= 40 && han < 2 && latinWords >= 5;
  }).length;
  const nonEmptyBlocks = (translation.blocks ?? []).filter((block) => typeof block.text === "string" && block.text.trim().length > 0).length;
  const titlePresent = typeof translation.title === "string" && translation.title.trim().length > 0;
  return {
    validStructure: titlePresent && exactBlockIds && nonEmptyBlocks === expectedIds.length,
    titlePresent,
    expectedBlocks: expectedIds.length,
    returnedBlocks: returnedIds.length,
    exactBlockIds,
    nonEmptyBlocks,
    numericRecall: recall(numberTokens(sourceText), numberTokens(translatedText)),
    cjkRatio: letters ? cjk / letters : 0,
    suspiciouslyShortBlocks,
    untranslatedBlocks,
  };
}

class MinuteRateLimiter {
  private readonly events: RateEvent[] = [];

  constructor(private readonly requestsPerMinute: number, private readonly tokensPerMinute: number) {}

  async acquire(estimatedTokens: number): Promise<RateEvent> {
    for (;;) {
      const now = Date.now();
      while (this.events.length && this.events[0]!.at <= now - 61_000) this.events.shift();
      const tokenTotal = this.events.reduce((total, event) => total + event.tokens, 0);
      if (this.events.length < this.requestsPerMinute && tokenTotal + estimatedTokens <= this.tokensPerMinute) {
        const event = { at: now, tokens: estimatedTokens };
        this.events.push(event);
        return event;
      }
      const earliest = this.events[0]?.at ?? now;
      await new Promise((resolve) => setTimeout(resolve, Math.max(1_000, earliest + 61_000 - now)));
    }
  }
}

function estimatedPromptTokens(prompt: string, chineseHeavy = false): number {
  return Math.ceil(prompt.length / (chineseHeavy ? 2 : 3.5)) + 300;
}

async function geminiCall(input: {
  apiKey: string;
  model: string;
  prompt: string;
  limiter: MinuteRateLimiter;
  chineseHeavy?: boolean;
  maximumAttempts?: number;
  thinkingLevel?: "minimal" | "low" | "medium" | "high";
}): Promise<GeminiCallResult> {
  const event = await input.limiter.acquire(estimatedPromptTokens(input.prompt, input.chineseHeavy));
  const started = Date.now();
  const maximumAttempts = input.maximumAttempts ?? 5;
  let lastError = "Unknown Gemini API error";
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180_000);
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": input.apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: input.prompt }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 32_768,
            responseMimeType: "application/json",
            thinkingConfig: { thinkingLevel: input.thinkingLevel ?? "minimal" },
          },
        }),
        signal: controller.signal,
      });
      const payload = await response.json() as GeminiResponse;
      if (!response.ok) {
        lastError = payload.error?.message ?? `Gemini returned HTTP ${response.status}`;
        if (response.status !== 429 && response.status < 500) throw new Error(lastError);
        const retryAfter = Number(response.headers.get("retry-after") ?? "0");
        await new Promise((resolve) => setTimeout(resolve, Math.max(2_000, retryAfter * 1_000, attempt * 5_000)));
        continue;
      }
      const candidate = payload.candidates?.[0];
      const text = candidate?.content?.parts?.filter((part) => !part.thought).map((part) => part.text ?? "").join("").trim() ?? "";
      if (!text) throw new Error(`Gemini returned no final text (${candidate?.finishReason ?? "unknown"})`);
      const promptTokens = payload.usageMetadata?.promptTokenCount ?? event.tokens;
      event.tokens = promptTokens;
      return {
        text,
        latencyMs: Date.now() - started,
        promptTokens,
        outputTokens: payload.usageMetadata?.candidatesTokenCount ?? 0,
        attempts: attempt,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt >= maximumAttempts) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * 3_000));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(lastError);
}

async function readJsonLines<T>(file: string): Promise<T[]> {
  try {
    return (await readFile(file, "utf8")).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as T);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function translateSample(input: {
  apiKey: string;
  model: string;
  articles: BenchmarkArticle[];
  outputFile: string;
  onProgress?: (message: string) => void;
}): Promise<TranslationResult[]> {
  await mkdir(path.dirname(input.outputFile), { recursive: true });
  const previous = await readJsonLines<TranslationResult>(input.outputFile);
  const results = new Map(previous.map((result) => [result.articleId, result]));
  const complete = new Map(previous.filter((result) => result.translation).map((result) => [result.articleId, result]));
  const limiter = new MinuteRateLimiter(28, 14_000);
  for (let index = 0; index < input.articles.length; index += 1) {
    const article = input.articles[index]!;
    if (complete.has(article.id)) continue;
    input.onProgress?.(`${input.model} ${index + 1}/${input.articles.length}: ${article.sourceId} ${article.title.slice(0, 80)}`);
    const startedAt = new Date().toISOString();
    let result: TranslationResult;
    try {
      const chunks = splitArticleForTranslation(article);
      const translation: TranslationPayload = { title: "", blocks: [] };
      let latencyMs = 0;
      let promptTokens = 0;
      let outputTokens = 0;
      let attempts = 0;
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
        const chunk = chunks[chunkIndex]!;
        if (chunks.length > 1) input.onProgress?.(`${input.model} ${index + 1}/${input.articles.length} chunk ${chunkIndex + 1}/${chunks.length}`);
        const call = await geminiCall({
          apiKey: input.apiKey,
          model: input.model,
          prompt: buildTranslationPrompt(chunk),
          limiter,
          maximumAttempts: 2,
        });
        const chunkTranslation = parseJsonText<TranslationPayload>(call.text);
        if (chunkIndex === 0) translation.title = chunkTranslation.title;
        translation.blocks.push(...(chunkTranslation.blocks ?? []));
        latencyMs += call.latencyMs;
        promptTokens += call.promptTokens;
        outputTokens += call.outputTokens;
        attempts += call.attempts;
      }
      const validation = validateTranslation(article, translation);
      result = {
        articleId: article.id,
        model: input.model,
        startedAt,
        latencyMs,
        promptTokens,
        outputTokens,
        attempts,
        translation,
        validation,
      };
      complete.set(article.id, result);
    } catch (error) {
      result = {
        articleId: article.id,
        model: input.model,
        startedAt,
        latencyMs: 0,
        promptTokens: 0,
        outputTokens: 0,
        attempts: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    results.set(article.id, result);
    await appendFile(input.outputFile, `${JSON.stringify(result)}\n`, "utf8");
  }
  return input.articles.map((article) => results.get(article.id)!).filter(Boolean);
}

function renderedTranslation(result: TranslationResult): string {
  if (!result.translation) return result.error ?? "Translation missing";
  return [result.translation.title, ...result.translation.blocks.map((block) => block.text)].join("\n");
}

function judgePrompt(article: BenchmarkArticle, a: TranslationResult, b: TranslationResult): string {
  return [
    "Act as a strict bilingual news translation evaluator. Compare two Simplified Chinese translations against the English source.",
    "Score each translation from 0 to 10 for faithfulness, completeness, Chinese quality, and terminology.",
    "Treat omitted facts, invented facts, changed numbers, changed attribution, or altered uncertainty as critical errors.",
    "Prefer A, B, or tie. Ignore formatting differences. Return JSON only in the requested shape.",
    "Shape: {\"preferred\":\"A|B|tie\",\"a\":{\"faithfulness\":0,\"completeness\":0,\"chineseQuality\":0,\"terminology\":0,\"criticalErrors\":[]},\"b\":{...},\"reason\":\"...\"}",
    `SOURCE:\n${article.title}\n${article.blocks.map((block) => `[${block.id}] ${block.text}`).join("\n")}`,
    `TRANSLATION A:\n${renderedTranslation(a)}`,
    `TRANSLATION B:\n${renderedTranslation(b)}`,
  ].join("\n\n");
}

function validAssessment(value: unknown): value is JudgeAssessment {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return ["faithfulness", "completeness", "chineseQuality", "terminology"].every((key) => typeof row[key] === "number")
    && Array.isArray(row.criticalErrors);
}

export async function judgeHardCases(input: {
  apiKey: string;
  judgeModel: string;
  articles: BenchmarkArticle[];
  leftModel: string;
  left: TranslationResult[];
  rightModel: string;
  right: TranslationResult[];
  count: number;
  outputFile: string;
  onProgress?: (message: string) => void;
}): Promise<JudgeResult[]> {
  const byLeft = new Map(input.left.map((result) => [result.articleId, result]));
  const byRight = new Map(input.right.map((result) => [result.articleId, result]));
  const hard = [...input.articles]
    .filter((article) => byLeft.get(article.id)?.translation && byRight.get(article.id)?.translation)
    .sort((left, right) => right.complexity - left.complexity)
    .slice(0, input.count);
  const previous = await readJsonLines<JudgeResult>(input.outputFile);
  const complete = new Map(previous.filter((result) => !result.error).map((result) => [result.articleId, result]));
  const limiter = new MinuteRateLimiter(4, 220_000);
  for (let index = 0; index < hard.length; index += 1) {
    const article = hard[index]!;
    if (complete.has(article.id)) continue;
    const swap = stableHash(article.id) % 2 === 1;
    const aModel = swap ? input.rightModel : input.leftModel;
    const bModel = swap ? input.leftModel : input.rightModel;
    const a = (swap ? byRight : byLeft).get(article.id)!;
    const b = (swap ? byLeft : byRight).get(article.id)!;
    input.onProgress?.(`${input.judgeModel} judge ${index + 1}/${hard.length}: ${article.sourceId} ${article.title.slice(0, 80)}`);
    let result: JudgeResult;
    try {
      const call = await geminiCall({
        apiKey: input.apiKey,
        model: input.judgeModel,
        prompt: judgePrompt(article, a, b),
        limiter,
        chineseHeavy: true,
        maximumAttempts: 1,
        thinkingLevel: "low",
      });
      const parsed = parseJsonText<{ preferred: "A" | "B" | "tie"; a: JudgeAssessment; b: JudgeAssessment; reason: string }>(call.text);
      if (!["A", "B", "tie"].includes(parsed.preferred) || !validAssessment(parsed.a) || !validAssessment(parsed.b)) {
        throw new Error("Judge returned an invalid assessment shape");
      }
      result = {
        articleId: article.id,
        model: input.judgeModel,
        latencyMs: call.latencyMs,
        promptTokens: call.promptTokens,
        outputTokens: call.outputTokens,
        preferred: parsed.preferred,
        aModel,
        bModel,
        a: parsed.a,
        b: parsed.b,
        reason: parsed.reason,
      };
      complete.set(article.id, result);
    } catch (error) {
      result = {
        articleId: article.id,
        model: input.judgeModel,
        latencyMs: 0,
        promptTokens: 0,
        outputTokens: 0,
        preferred: "tie",
        aModel,
        bModel,
        a: { faithfulness: 0, completeness: 0, chineseQuality: 0, terminology: 0, criticalErrors: [] },
        b: { faithfulness: 0, completeness: 0, chineseQuality: 0, terminology: 0, criticalErrors: [] },
        reason: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    await appendFile(input.outputFile, `${JSON.stringify(result)}\n`, "utf8");
  }
  return hard.map((article) => complete.get(article.id) ?? previous.find((row) => row.articleId === article.id)!).filter(Boolean);
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

function fixed(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "0";
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function modelSummary(model: string, results: TranslationResult[]): Record<string, string | number> {
  const successful = results.filter((result) => result.translation && result.validation);
  return {
    model,
    attempted: results.length,
    successful: successful.length,
    validStructure: successful.filter((result) => result.validation!.validStructure).length,
    numericRecall: fixed(average(successful.map((result) => result.validation!.numericRecall)) * 100, 1),
    shortBlocks: successful.reduce((sum, result) => sum + result.validation!.suspiciouslyShortBlocks, 0),
    untranslatedBlocks: successful.reduce((sum, result) => sum + result.validation!.untranslatedBlocks, 0),
    medianLatencySeconds: fixed(percentile(successful.map((result) => result.latencyMs), 0.5) / 1_000, 1),
    p95LatencySeconds: fixed(percentile(successful.map((result) => result.latencyMs), 0.95) / 1_000, 1),
    promptTokens: successful.reduce((sum, result) => sum + result.promptTokens, 0),
    outputTokens: successful.reduce((sum, result) => sum + result.outputTokens, 0),
  };
}

export async function writeBenchmarkReport(input: {
  outputRoot: string;
  articles: BenchmarkArticle[];
  models: Array<{ model: string; results: TranslationResult[] }>;
  judges: JudgeResult[];
}): Promise<{ markdown: string; html: string }> {
  const summaries = input.models.map(({ model, results }) => modelSummary(model, results));
  const validJudges = input.judges.filter((judge) => !judge.error);
  const preferences = Object.fromEntries(input.models.map(({ model }) => [model, 0])) as Record<string, number>;
  let ties = 0;
  for (const judge of validJudges) {
    if (judge.preferred === "tie") ties += 1;
    else preferences[judge.preferred === "A" ? judge.aModel : judge.bModel] = (preferences[judge.preferred === "A" ? judge.aModel : judge.bModel] ?? 0) + 1;
  }
  const judgeSummaries = input.models.map(({ model }) => {
    const assessments = validJudges.flatMap((judge) => judge.aModel === model ? [judge.a] : judge.bModel === model ? [judge.b] : []);
    return {
      model,
      faithfulness: fixed(average(assessments.map((row) => row.faithfulness))),
      completeness: fixed(average(assessments.map((row) => row.completeness))),
      chineseQuality: fixed(average(assessments.map((row) => row.chineseQuality))),
      terminology: fixed(average(assessments.map((row) => row.terminology))),
      criticalErrors: assessments.reduce((sum, row) => sum + row.criticalErrors.length, 0),
    };
  });
  const judgeModels = [...new Set(validJudges.map((judge) => judge.model))]
    .map((model) => `${model}: ${validJudges.filter((judge) => judge.model === model).length}`)
    .join(", ");
  const report = [
    "# Times translation benchmark",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Articles: ${input.articles.length}`,
    `Sources: ${new Set(input.articles.map((article) => article.sourceId)).size}`,
    "",
    "## Automated checks",
    "",
    "| Model | Success | Structure | Numeric recall | Short blocks | Untranslated blocks | Median latency | P95 latency | Input tokens | Output tokens |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...summaries.map((row) => `| ${row.model} | ${row.successful}/${row.attempted} | ${row.validStructure}/${row.successful} | ${row.numericRecall}% | ${row.shortBlocks} | ${row.untranslatedBlocks} | ${row.medianLatencySeconds}s | ${row.p95LatencySeconds}s | ${row.promptTokens} | ${row.outputTokens} |`),
    "",
    "Numeric recall is an exact surface-form heuristic; localized values such as 65 billion → 650亿 are counted as mismatches. The two untranslated-block flags per model are an author byline and contact email preserved verbatim.",
    "",
    "## Gemini blind judge",
    "",
    `Valid judgements: ${validJudges.length}/${input.judges.length}`,
    `Judge models: ${judgeModels || "none"}`,
    ...Object.entries(preferences).map(([model, count]) => `- ${model}: ${count} preferred`),
    `- Ties: ${ties}`,
    "",
    "| Model | Faithfulness | Completeness | Chinese quality | Terminology | Critical errors |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...judgeSummaries.map((row) => `| ${row.model} | ${row.faithfulness} | ${row.completeness} | ${row.chineseQuality} | ${row.terminology} | ${row.criticalErrors} |`),
    "",
    "See review.html for the source and both translations side by side.",
    "",
  ].join("\n");
  const byModel = input.models.map(({ model, results }) => ({ model, rows: new Map(results.map((result) => [result.articleId, result])) }));
  const judgeByArticle = new Map(input.judges.map((judge) => [judge.articleId, judge]));
  const rows = input.articles.map((article) => {
    const translations = byModel.map(({ model, rows: modelRows }) => {
      const result = modelRows.get(article.id);
      return `<section><h3>${escapeHtml(model)}</h3><pre>${escapeHtml(result ? renderedTranslation(result) : "Missing")}</pre><p>${escapeHtml(JSON.stringify(result?.validation ?? result?.error ?? {}))}</p></section>`;
    }).join("");
    const judge = judgeByArticle.get(article.id);
    return `<article><h2>${escapeHtml(article.sourceName)} · ${escapeHtml(article.title)}</h2><p>${article.url ? `<a href="${escapeHtml(article.url)}">Original</a> · ` : ""}${article.bodyCharacters} chars · ${article.blocks.length} blocks</p><details><summary>English source</summary><pre>${escapeHtml(article.blocks.map((block) => `[${block.id}] ${block.text}`).join("\n"))}</pre></details><div class="translations">${translations}</div>${judge ? `<aside><strong>Judge:</strong> ${escapeHtml(judge.preferred)} (${escapeHtml(judge.aModel)} vs ${escapeHtml(judge.bModel)}) — ${escapeHtml(judge.reason || judge.error || "")}</aside>` : ""}</article>`;
  }).join("\n");
  const review = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Times translation benchmark</title><style>body{font:15px/1.6 system-ui;margin:24px;color:#202020}article{border-top:3px solid #8b1a1a;padding:18px 0}.translations{display:grid;grid-template-columns:1fr 1fr;gap:18px}pre{white-space:pre-wrap;background:#f6f2ea;padding:12px;max-height:520px;overflow:auto}aside{background:#fff3cd;padding:10px}@media(max-width:900px){.translations{grid-template-columns:1fr}}</style></head><body><h1>Times translation benchmark</h1>${rows}</body></html>`;
  const markdown = path.join(input.outputRoot, "report.md");
  const html = path.join(input.outputRoot, "review.html");
  await Promise.all([writeFile(markdown, report, "utf8"), writeFile(html, review, "utf8")]);
  return { markdown, html };
}

export async function loadEnvValue(file: string, name: string): Promise<string | undefined> {
  const content = await readFile(file, "utf8");
  for (const raw of content.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 0 || line.slice(0, separator).trim() !== name) continue;
    return line.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/u, "$2");
  }
  return undefined;
}
