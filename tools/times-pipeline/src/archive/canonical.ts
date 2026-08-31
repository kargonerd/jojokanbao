import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import { articleId, normalizeArticleUrl } from "../identity.js";
import type { ProcessedCandidate } from "../process/article.js";
import { writeCanonicalSource, type CanonicalWriteResult } from "../process/canonical-writer.js";
import type {
  CapturedAsset,
  PublisherSectionRef,
  SourceCaptureManifest,
  SourceConfig,
} from "../types.js";

const INPUT_FORMAT = "jojo-news-canonical-input/1" as const;
const PREPARED_FORMAT = "jojo-news-canonical-prepared/1" as const;
const RECORD_MARKER = "/raw/records/";
const INLINE_TAGS = new Set(["a", "b", "br", "code", "em", "i", "s", "strong", "sub", "sup", "u"]);

interface ArchiveBlobReference {
  path: string;
  sha256: string;
  byteCount: number;
  storedByteCount: number;
  contentEncoding?: string;
}

interface ArchiveDependentResource {
  sourceUrl: string;
  snapshotUrl: string;
  contentType: string;
  blob: ArchiveBlobReference;
}

interface ArchiveCaptureRecord {
  publisher: string;
  canonicalUrl: string;
  retrievedAt: string;
  finalUrl: string;
  qualityScore: number;
  selectedCandidate: { provider: string };
  rawHtml: ArchiveBlobReference;
  dependentResources: ArchiveDependentResource[];
}

interface ArchiveRawRunManifest {
  formatVersion?: unknown;
  runId?: unknown;
  migrationComplete?: unknown;
  legacyB2Prefix?: unknown;
  hfPrefix?: unknown;
  sourceRevision?: unknown;
  phases?: unknown;
  objects?: unknown;
  source?: unknown;
}

interface ArchiveRawRunFile {
  size: number;
  sha256: string;
  required: boolean;
}

export interface ArchiveRawRunValidation {
  runId: string;
  hfPrefix: string;
  publisher: string;
  sourceRevision: string;
  immutableFiles: ReadonlyMap<string, ArchiveRawRunFile>;
}

type ArchiveBlockType = "paragraph" | "heading" | "image" | "quote" | "list" | "table" | "embed" | "divider";

interface ArchiveContentBlock {
  type: ArchiveBlockType;
  position: number;
  text?: string;
  html?: string;
  level?: number;
  items: string[];
  assetId?: string;
  caption?: string;
  credit?: string;
  embedUrl?: string;
}

interface ArchiveImageCandidate {
  assetId: string;
  role: "lead" | "body" | "chart" | "infographic" | "author-avatar" | "recommendation" | "advertisement" | "logo" | "icon" | "tracking" | "unknown";
  originalUrl: string;
  candidateUrls: string[];
  caption?: string;
  credit?: string;
  alt?: string;
  width?: number;
  height?: number;
  shouldArchive: boolean;
}

interface ArchiveParserResult {
  canonicalUrl: string;
  language: string;
  section?: string;
  headline: string;
  authors: Array<{ name: string }>;
  publishedAt: string;
  modifiedAt?: string;
  blocks: ArchiveContentBlock[];
  images: ArchiveImageCandidate[];
  extraction: { parserVersion: string };
  quality: {
    status: "complete" | "partial" | "error" | "unsupported";
    bodyCharacters: number;
    imagesSelected: number;
  };
}

export interface ArchiveCanonicalInput {
  formatVersion: typeof INPUT_FORMAT;
  sourceId: string;
  publisher: string;
  canonicalUrl: string;
  recordObject: string;
  rawHtmlObject: string;
  rawRevision: string;
  rawRunId: string;
  rawRunManifest: string;
  captureRecord: ArchiveCaptureRecord;
  parserResult: ArchiveParserResult;
  validation: {
    sampleYear: number;
    parserVersion: string;
    qaRevision: string;
    qaPass: boolean;
    issues: string[];
    sourceRawSha256: string;
  };
}

export interface PreparedArchiveRow {
  formatVersion: typeof PREPARED_FORMAT;
  sourceRawRevision: string;
  rawRunId: string;
  rawRunManifest: string;
  recordObject: string;
  provider: string;
  retrievedAt: string;
  candidate: ProcessedCandidate;
}

export type ArchiveAssetDownload = (
  url: string,
  referer: string,
) => Promise<{ body: Buffer; mediaType: string } | undefined>;

interface CapturedArchiveImage {
  parserAssetId: string;
  asset: CapturedAsset;
}

interface LocalResource {
  body: Buffer;
  mediaType: string;
}

const ARCHIVE_ONLY_SOURCES: Record<string, Omit<SourceConfig, "enabled">> = {
  wsj: {
    id: "wsj",
    name: "The Wall Street Journal",
    language: "en",
    publicationTimeZone: "America/New_York",
    discovery: { kind: "sitemap", url: "https://www.wsj.com/sitemap.xml", maximumPages: 1 },
    content: { priority: ["captured-page"], parser: "wsj" },
    fetch: { strategy: "direct-first", bpc: false },
    health: { minimumCandidates: 0 },
  },
  "nikkei-japan": {
    id: "nikkei-japan",
    name: "Nikkei",
    language: "ja",
    publicationTimeZone: "Asia/Tokyo",
    discovery: { kind: "sitemap", url: "https://www.nikkei.com/sitemap.xml", maximumPages: 1 },
    content: { priority: ["captured-page"], parser: "nikkei" },
    fetch: { strategy: "direct-first", bpc: false },
    health: { minimumCandidates: 0 },
  },
};

export function isArchiveOnlySource(sourceId: string): boolean {
  return Object.prototype.hasOwnProperty.call(ARCHIVE_ONLY_SOURCES, sourceId);
}

export function archiveOnlySourceIds(): string[] {
  return Object.keys(ARCHIVE_ONLY_SOURCES).sort();
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function safeObjectName(value: string, label: string): string {
  const normalized = value.replaceAll("\\", "/");
  const components = normalized.split("/");
  if (
    normalized !== value
    || normalized.startsWith("/")
    || path.posix.isAbsolute(normalized)
    || path.win32.isAbsolute(normalized)
    || /^[a-z]:/iu.test(normalized)
    || components.some((component) => !component || component === "." || component === "..")
    || path.posix.normalize(normalized) !== normalized
  ) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
  return normalized;
}

function localObjectPath(workspace: string, objectName: string): string {
  const normalized = safeObjectName(objectName, "archive object path");
  const root = path.resolve(workspace);
  const target = path.resolve(root, ...normalized.split("/"));
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Archive object escapes the workspace: ${objectName}`);
  }
  return target;
}

type ArchiveRawPhase = "immutable" | "catalog" | "checkpoint" | "completion";

function archiveRawPhase(objectName: string, hfPrefix: string): ArchiveRawPhase | undefined {
  const prefix = `${hfPrefix}/`;
  if (!objectName.startsWith(prefix)) return undefined;
  const [area, ...relative] = objectName.slice(prefix.length).split("/");
  if (area === "raw" && relative.length >= 2 && ["objects", "records"].includes(relative[0]!)) {
    return "immutable";
  }
  if (area === "catalog" && relative.length > 0) return "catalog";
  if (area === "audit" && relative.length > 0) return "checkpoint";
  if (area === "state" && relative.length > 0) {
    const filename = relative[0]!;
    if (relative.length === 1 && (filename === "summary.json" || filename.endsWith("-summary.json"))) {
      return "completion";
    }
    return "checkpoint";
  }
  return undefined;
}

async function validateRawRunManifest(
  workspace: string,
  rawRunManifest: string,
): Promise<ArchiveRawRunValidation> {
  if (!/^raw\/archive\/runs\/\d{4}\/\d{2}\/\d{2}\/[a-z0-9][a-z0-9.-]*\/manifest\.json$/u.test(rawRunManifest)) {
    throw new Error(`${rawRunManifest}: historical Raw run manifest has an invalid object path`);
  }
  let manifest: ArchiveRawRunManifest;
  try {
    manifest = JSON.parse(await readFile(localObjectPath(workspace, rawRunManifest), "utf8")) as ArchiveRawRunManifest;
  } catch (error) {
    throw new Error(`${rawRunManifest}: historical Raw run manifest is missing or invalid`, { cause: error });
  }
  const pathRunId = rawRunManifest.split("/").at(-2);
  const source = objectValue(manifest.source, "Raw run source");
  const publisher = requiredString(source.publisher, "Raw run source publisher");
  const window = requiredString(source.window, "Raw run source window");
  const mode = requiredString(source.mode, "Raw run source mode");
  if (
    manifest.formatVersion !== "jojo-news-archive-raw-run/1"
    || manifest.migrationComplete !== true
    || typeof manifest.runId !== "string"
    || pathRunId !== manifest.runId
    || typeof manifest.hfPrefix !== "string"
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(publisher)
    || !/^\d{4}-\d{4}$/u.test(window)
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(mode)
    || manifest.legacyB2Prefix !== `news-archive/v1/${publisher}/${window}/${mode}`
    || manifest.hfPrefix !== `raw/archive/v1/${publisher}/${window}/${mode}`
    || typeof manifest.sourceRevision !== "string"
    || !/^[a-f0-9]{40}$/u.test(manifest.sourceRevision)
  ) {
    throw new Error(`${rawRunManifest}: historical Raw run manifest is invalid`);
  }
  const prefix = `${manifest.hfPrefix}/`;
  const phaseOrder = ["immutable", "catalog", "checkpoint", "completion"] as const;
  if (!Array.isArray(manifest.phases) || manifest.phases.length !== phaseOrder.length) {
    throw new Error(`${rawRunManifest}: historical Raw run has no complete phase provenance`);
  }
  const runRoot = rawRunManifest.slice(0, -"/manifest.json".length);
  const objectNames = new Set<string>();
  const immutableFiles = new Map<string, ArchiveRawRunFile>();
  let totalFiles = 0;
  let totalBytes = 0;
  for (const [index, expectedPhase] of phaseOrder.entries()) {
    const row = objectValue(manifest.phases[index], `Raw run ${expectedPhase} phase`);
    const fileSet = row.fileSet;
    const fileSetSha256 = row.fileSetSha256;
    const revision = row.revision;
    const expectedFileSet = `${runRoot}/file-sets/0${index + 1}-${expectedPhase}.json`;
    if (
      row.phase !== expectedPhase
      || fileSet !== expectedFileSet
      || typeof fileSetSha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(fileSetSha256)
      || typeof revision !== "string"
      || !/^[a-f0-9]{40}$/u.test(revision)
      || (expectedPhase === "completion" && revision !== manifest.sourceRevision)
    ) {
      throw new Error(`${rawRunManifest}: historical Raw ${expectedPhase} phase is invalid`);
    }
    let fileSetBytes: Buffer;
    let files: unknown[];
    try {
      fileSetBytes = await readFile(localObjectPath(workspace, fileSet));
      const payload = JSON.parse(fileSetBytes.toString("utf8")) as { formatVersion?: unknown; files?: unknown };
      if (payload.formatVersion !== "jojo-hf-file-set/1" || !Array.isArray(payload.files)) throw new Error("invalid file set");
      files = payload.files;
    } catch (error) {
      throw new Error(`${rawRunManifest}: historical Raw ${expectedPhase} file set is missing or invalid`, { cause: error });
    }
    if (createHash("sha256").update(fileSetBytes).digest("hex") !== fileSetSha256) {
      throw new Error(`${rawRunManifest}: historical Raw ${expectedPhase} file-set checksum mismatch`);
    }
    if (expectedPhase === "completion" && files.length === 0) {
      throw new Error(`${rawRunManifest}: historical Raw run has no completion summary`);
    }
    let phaseBytes = 0;
    for (const [fileIndex, value] of files.entries()) {
      const file = objectValue(value, `Raw run ${expectedPhase} file ${fileIndex}`);
      const objectName = requiredString(file.objectName, `Raw run ${expectedPhase} objectName`);
      const sha256 = requiredString(file.sha256, `Raw run ${expectedPhase} sha256`);
      const size = file.size;
      safeObjectName(objectName, `Raw run ${expectedPhase} objectName`);
      if (
        !objectName.startsWith(prefix)
        || archiveRawPhase(objectName, manifest.hfPrefix) !== expectedPhase
        || !/^[a-f0-9]{64}$/u.test(sha256)
        || !Number.isSafeInteger(size)
        || (size as number) < 0
        || typeof file.required !== "boolean"
        || objectNames.has(objectName)
      ) {
        throw new Error(`${rawRunManifest}: historical Raw ${expectedPhase} file set contains an invalid object`);
      }
      objectNames.add(objectName);
      phaseBytes += size as number;
      if (expectedPhase === "immutable") {
        immutableFiles.set(objectName, { size: size as number, sha256, required: file.required });
      }
    }
    if (row.files !== files.length || row.bytes !== phaseBytes) {
      throw new Error(`${rawRunManifest}: historical Raw ${expectedPhase} totals do not match its file set`);
    }
    totalFiles += files.length;
    totalBytes += phaseBytes;
  }
  const objects = objectValue(manifest.objects, "Raw run object totals");
  if (objects.files !== totalFiles || objects.bytes !== totalBytes || totalFiles === 0) {
    throw new Error(`${rawRunManifest}: historical Raw object totals do not match its phase file sets`);
  }
  return {
    runId: manifest.runId,
    hfPrefix: manifest.hfPrefix,
    publisher,
    sourceRevision: manifest.sourceRevision,
    immutableFiles,
  };
}

function rawRootObject(recordObject: string): string {
  const normalized = safeObjectName(recordObject, "record object");
  if (!normalized.startsWith("raw/archive/v1/") || !normalized.includes(RECORD_MARKER) || !normalized.endsWith(".json")) {
    throw new Error(`Record is outside historical v1 Raw: ${recordObject}`);
  }
  return `${normalized.split(RECORD_MARKER, 1)[0]}/raw`;
}

function blobObject(recordObject: string, blob: ArchiveBlobReference): string {
  const relative = safeObjectName(blob.path, "archive blob reference");
  if (!relative.startsWith("objects/")) throw new Error(`Archive blob must be below objects/: ${relative}`);
  return `${rawRootObject(recordObject)}/${relative}`;
}

async function readVerifiedBlob(
  workspace: string,
  recordObject: string,
  blob: ArchiveBlobReference,
): Promise<Buffer> {
  const objectName = blobObject(recordObject, blob);
  const stored = await readFile(localObjectPath(workspace, objectName));
  if (stored.byteLength !== blob.storedByteCount) {
    throw new Error(`Stored byte count mismatch for ${objectName}`);
  }
  const body = blob.contentEncoding === "gzip"
    ? gunzipSync(stored)
    : blob.contentEncoding === undefined
      ? stored
      : (() => { throw new Error(`Unsupported content encoding for ${objectName}: ${blob.contentEncoding}`); })();
  if (body.byteLength !== blob.byteCount) throw new Error(`Raw byte count mismatch for ${objectName}`);
  const digest = createHash("sha256").update(body).digest("hex");
  if (digest !== blob.sha256) throw new Error(`Raw SHA-256 mismatch for ${objectName}`);
  return body;
}

function validHttpUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function imageExtension(mediaType: string, sourceUrl: string): string {
  const byType: Record<string, string> = {
    "image/avif": "avif",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/svg+xml": "svg",
    "image/webp": "webp",
  };
  if (byType[mediaType]) return byType[mediaType]!;
  try {
    const suffix = path.posix.extname(new URL(sourceUrl).pathname).slice(1).toLowerCase();
    if (/^(?:avif|gif|jpe?g|png|svg|webp)$/u.test(suffix)) return suffix === "jpeg" ? "jpg" : suffix;
  } catch {
    // Use a neutral extension when neither MIME type nor URL identifies the image.
  }
  return "bin";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function safeInlineHtml(raw: string | undefined, fallback: string | undefined): string {
  if (!raw?.trim()) return escapeHtml(fallback?.trim() ?? "");
  const $ = load(`<div data-archive-inline-root>${raw}</div>`, undefined, false);
  const root = $("[data-archive-inline-root]");
  root.find("script,style,noscript,iframe,video,audio,picture,source,img,svg,canvas,form,input,button").remove();
  const elements = root.find("*").toArray().reverse();
  for (const element of elements) {
    const current = $(element);
    const tag = element.tagName.toLowerCase();
    if (!INLINE_TAGS.has(tag)) {
      current.replaceWith(current.contents());
      continue;
    }
    const href = tag === "a" ? current.attr("href") : undefined;
    for (const attribute of Object.keys(current.attr() ?? {})) current.removeAttr(attribute);
    if (tag === "a") {
      if (href && validHttpUrl(href)) current.attr("href", href);
      else current.replaceWith(current.contents());
    }
  }
  return root.html()?.trim() || escapeHtml(fallback?.trim() ?? "");
}

function tableRows(block: ArchiveContentBlock): string[] {
  if (!block.html?.trim()) return block.text?.trim() ? [block.text.trim()] : [];
  const $ = load(block.html, undefined, false);
  const rows = $("tr").toArray().map((row) => (
    $(row).find("th,td").toArray().map((cell) => $(cell).text().replaceAll(/\s+/gu, " ").trim()).filter(Boolean).join(" — ")
  )).filter(Boolean);
  return rows.length ? rows : block.text?.trim() ? [block.text.trim()] : [];
}

function semanticTextBlock(block: ArchiveContentBlock): string | undefined {
  if (block.type === "paragraph") {
    const value = safeInlineHtml(block.html, block.text);
    if (!value) return undefined;
    return /^\s*<pre[\s>]/iu.test(block.html ?? "") ? `<pre>${value}</pre>` : `<p>${value}</p>`;
  }
  if (block.type === "heading") {
    const level = Math.min(4, Math.max(2, block.level ?? 2));
    const value = safeInlineHtml(block.html, block.text);
    return value ? `<h${level}>${value}</h${level}>` : undefined;
  }
  if (block.type === "quote") {
    const value = safeInlineHtml(block.html, block.text);
    return value ? `<blockquote>${value}</blockquote>` : undefined;
  }
  if (block.type === "list") {
    const items = block.items.map((item) => item.trim()).filter(Boolean);
    if (!items.length) return undefined;
    const ordered = /^\s*<ol[\s>]/iu.test(block.html ?? "");
    const tag = ordered ? "ol" : "ul";
    return `<${tag}>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</${tag}>`;
  }
  if (block.type === "table") {
    const rows = tableRows(block);
    if (!rows.length) return undefined;
    return `<ul>${rows.map((row) => `<li>${escapeHtml(row)}</li>`).join("")}</ul>`;
  }
  if (block.type === "embed" && block.embedUrl && validHttpUrl(block.embedUrl)) {
    return `<p><a href="${escapeHtml(block.embedUrl)}">${escapeHtml(block.text?.trim() || block.embedUrl)}</a></p>`;
  }
  return undefined;
}

function figure(asset: CapturedAsset): string {
  return `<figure data-asset-id="${escapeHtml(asset.id)}">${asset.caption ? `<figcaption>${escapeHtml(asset.caption)}</figcaption>` : ""}</figure>`;
}

function renderedBody(
  blocks: readonly ArchiveContentBlock[],
  images: readonly CapturedArchiveImage[],
): string {
  const byParserId = new Map(images.map((row) => [row.parserAssetId, row.asset]));
  const renderedAssets = new Set<string>();
  const values: string[] = [];
  const sortedBlocks = [...blocks].sort((left, right) => left.position - right.position);
  const blockAssetIds = new Set(sortedBlocks.flatMap((block) => block.assetId ? [block.assetId] : []));
  for (const row of images) {
    if (row.asset.role === "lead" && !blockAssetIds.has(row.parserAssetId) && !renderedAssets.has(row.asset.id)) {
      values.push(figure(row.asset));
      renderedAssets.add(row.asset.id);
    }
  }
  for (const block of sortedBlocks) {
    if (block.type === "image" && block.assetId) {
      const asset = byParserId.get(block.assetId);
      if (asset && !renderedAssets.has(asset.id)) {
        values.push(figure(asset));
        renderedAssets.add(asset.id);
      }
      continue;
    }
    const value = semanticTextBlock(block);
    if (value) values.push(value);
  }
  for (const row of images) {
    if (!renderedAssets.has(row.asset.id)) {
      values.push(figure(row.asset));
      renderedAssets.add(row.asset.id);
    }
  }
  return values.join("");
}

function normalizedLanguage(value: string, fallback: string): string {
  const language = value.trim().toLowerCase().replaceAll("_", "-");
  if (language === "zh" || language.startsWith("zh-")) return "zh-CN";
  if (language === "ja" || language.startsWith("ja-")) return "ja";
  if (language === "en" || language.startsWith("en-")) return "en";
  return language || fallback;
}

function publisherSections(source: SourceConfig, category: string | undefined): PublisherSectionRef[] {
  if (!category?.trim()) return [];
  const expected = category.trim().toLocaleLowerCase("en");
  return (source.sections ?? []).filter((section) => {
    const exactValues = [section.id, section.name, ...(section.match?.publisherCategories ?? [])]
      .map((value) => value.trim().toLocaleLowerCase("en"));
    return exactValues.includes(expected);
  }).map((section) => ({ id: section.id, name: section.name }));
}

export function archiveSourceConfig(sourceId: string, configured: readonly SourceConfig[]): SourceConfig {
  const source = configured.find((candidate) => candidate.id === sourceId);
  if (source) return source;
  const fallback = ARCHIVE_ONLY_SOURCES[sourceId];
  if (!fallback) throw new Error(`Historical source has no Times configuration: ${sourceId}`);
  return { ...fallback, enabled: true };
}

export function parseArchiveCanonicalInput(value: unknown): ArchiveCanonicalInput {
  const row = objectValue(value, "archive canonical input");
  if (row.formatVersion !== INPUT_FORMAT) throw new Error(`Unsupported archive canonical input: ${String(row.formatVersion)}`);
  const capture = objectValue(row.captureRecord, "captureRecord") as unknown as ArchiveCaptureRecord;
  const article = objectValue(row.parserResult, "parserResult") as unknown as ArchiveParserResult;
  const validation = objectValue(row.validation, "validation") as unknown as ArchiveCanonicalInput["validation"];
  const parsed = row as unknown as ArchiveCanonicalInput;
  for (const [label, item] of [
    ["sourceId", parsed.sourceId], ["publisher", parsed.publisher], ["canonicalUrl", parsed.canonicalUrl],
    ["recordObject", parsed.recordObject], ["rawHtmlObject", parsed.rawHtmlObject], ["rawRevision", parsed.rawRevision],
    ["rawRunId", parsed.rawRunId], ["rawRunManifest", parsed.rawRunManifest],
    ["captureRecord.publisher", capture.publisher], ["captureRecord.canonicalUrl", capture.canonicalUrl],
    ["captureRecord.retrievedAt", capture.retrievedAt],
    ["captureRecord.rawHtml.path", capture.rawHtml?.path], ["captureRecord.rawHtml.sha256", capture.rawHtml?.sha256],
    ["parserResult.canonicalUrl", article.canonicalUrl], ["parserResult.headline", article.headline],
    ["parserResult.publishedAt", article.publishedAt], ["parserResult.extraction.parserVersion", article.extraction?.parserVersion],
  ] as const) requiredString(item, label);
  safeObjectName(parsed.recordObject, "record object");
  safeObjectName(parsed.rawHtmlObject, "Raw HTML object");
  safeObjectName(parsed.rawRunManifest, "Raw run manifest");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(parsed.sourceId)) throw new Error(`Invalid historical source id: ${parsed.sourceId}`);
  if (!/^[a-f0-9]{40}$/u.test(parsed.rawRevision)) throw new Error(`Invalid historical Raw revision: ${parsed.rawRevision}`);
  if (!parsed.rawHtmlObject.startsWith("raw/archive/v1/") || !parsed.rawRunManifest.startsWith("raw/archive/")) {
    throw new Error(`${parsed.recordObject}: historical Raw provenance is outside raw/archive`);
  }
  if (
    parsed.canonicalUrl !== capture.canonicalUrl
    || parsed.canonicalUrl !== article.canonicalUrl
    || parsed.publisher !== capture.publisher
    || validation.parserVersion !== article.extraction.parserVersion
  ) throw new Error(`${parsed.recordObject}: historical parser provenance does not match the capture`);
  if (
    !/^[a-f0-9]{64}$/u.test(validation.sourceRawSha256)
    || validation.sourceRawSha256 !== capture.rawHtml.sha256
    || blobObject(parsed.recordObject, capture.rawHtml) !== parsed.rawHtmlObject
  ) throw new Error(`${parsed.recordObject}: historical Raw HTML provenance does not match the capture`);
  if (article.quality?.status !== "complete" || validation.qaPass !== true || validation.issues?.length !== 0) {
    throw new Error(`${parsed.recordObject}: historical parser QA has not passed`);
  }
  if (!Array.isArray(article.blocks) || !Array.isArray(article.images) || !Array.isArray(article.authors)) {
    throw new Error(`${parsed.recordObject}: historical parser result is incomplete`);
  }
  if (!Array.isArray(capture.dependentResources)) capture.dependentResources = [];
  return parsed;
}

async function localResources(
  input: ArchiveCanonicalInput,
  workspace: string,
): Promise<Map<string, LocalResource>> {
  const resources = new Map<string, LocalResource>();
  for (const resource of input.captureRecord.dependentResources) {
    if (!resource.contentType.toLowerCase().startsWith("image/")) continue;
    const body = await readVerifiedBlob(workspace, input.recordObject, resource.blob);
    const value = { body, mediaType: resource.contentType.split(";", 1)[0]!.trim().toLowerCase() };
    resources.set(resource.sourceUrl, value);
    resources.set(resource.snapshotUrl, value);
  }
  return resources;
}

async function captureImages(options: {
  input: ArchiveCanonicalInput;
  source: SourceConfig;
  workspace: string;
  download: ArchiveAssetDownload;
  concurrency: number;
}): Promise<CapturedArchiveImage[]> {
  const selected = options.input.parserResult.images.filter((image) => image.shouldArchive);
  const local = await localResources(options.input, options.workspace);
  const captured = new Array<CapturedArchiveImage | undefined>(selected.length);
  let cursor = 0;
  const consume = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      const image = selected[index];
      if (!image) return;
      const urls = [...new Set([...image.candidateUrls, image.originalUrl])].filter(validHttpUrl);
      let result: LocalResource | undefined;
      for (const url of urls) {
        result = local.get(url) ?? await options.download(url, options.input.canonicalUrl);
        if (result?.mediaType.startsWith("image/") && result.body.byteLength > 0 && result.body.byteLength <= 30_000_000) break;
        result = undefined;
      }
      if (!result) continue;
      const digest = createHash("sha256").update(result.body).digest("hex");
      const suffix = imageExtension(result.mediaType, image.originalUrl);
      const objectName = `raw/archive/assets/${options.source.id}/${digest}.${suffix}`;
      const target = localObjectPath(options.workspace, objectName);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, result.body);
      captured[index] = {
        parserAssetId: image.assetId,
        asset: {
          id: `asset:${digest}`,
          type: "image",
          role: image.role === "lead" ? "lead" : "content",
          sourceUrl: image.originalUrl,
          rawObject: objectName,
          mediaType: result.mediaType,
          size: result.body.byteLength,
          sha256: digest,
          ...(image.alt ? { alt: image.alt } : {}),
          ...(image.caption ? { caption: image.caption } : {}),
          ...(image.credit ? { credit: image.credit } : {}),
          ...(image.width ? { width: image.width } : {}),
          ...(image.height ? { height: image.height } : {}),
        },
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, selected.length) }, consume));
  const byDigest = new Map<string, CapturedAsset>();
  for (const row of captured) {
    if (!row) continue;
    const previous = byDigest.get(row.asset.id);
    if (!previous) byDigest.set(row.asset.id, row.asset);
    else if (row.asset.role === "lead") previous.role = "lead";
    row.asset = byDigest.get(row.asset.id)!;
  }
  return captured.filter((row): row is CapturedArchiveImage => row !== undefined);
}

export async function prepareArchiveRow(options: {
  value: unknown;
  sources: readonly SourceConfig[];
  workspace: string;
  download: ArchiveAssetDownload;
  imageConcurrency?: number;
  runManifestValidationCache?: Map<string, Promise<ArchiveRawRunValidation>>;
}): Promise<PreparedArchiveRow> {
  const input = parseArchiveCanonicalInput(options.value);
  const validationKey = `${path.resolve(options.workspace)}\0${input.rawRunManifest}`;
  let validation = options.runManifestValidationCache?.get(validationKey);
  if (!validation) {
    validation = validateRawRunManifest(options.workspace, input.rawRunManifest);
    options.runManifestValidationCache?.set(validationKey, validation);
  }
  const rawRun = await validation;
  const prefix = `${rawRun.hfPrefix}/`;
  const record = rawRun.immutableFiles.get(input.recordObject);
  const rawHtml = rawRun.immutableFiles.get(input.rawHtmlObject);
  const sourceMatchesPublisher = input.sourceId === rawRun.publisher
    || (rawRun.publisher === "nikkei" && input.sourceId === "nikkei-japan");
  if (
    rawRun.runId !== input.rawRunId
    || input.publisher !== rawRun.publisher
    || !sourceMatchesPublisher
    || !input.recordObject.startsWith(prefix)
    || !input.rawHtmlObject.startsWith(prefix)
    || !record?.required
    || !rawHtml?.required
  ) {
    throw new Error(`${input.recordObject}: historical Raw run manifest does not match the Canonical input`);
  }
  const source = archiveSourceConfig(input.sourceId, options.sources);
  const images = await captureImages({
    input,
    source,
    workspace: options.workspace,
    download: options.download,
    concurrency: Math.max(1, options.imageConcurrency ?? 4),
  });
  const body = renderedBody(input.parserResult.blocks, images);
  if (!body.trim()) throw new Error(`${input.recordObject}: no publishable semantic body remains`);
  const canonicalUrl = normalizeArticleUrl(input.parserResult.canonicalUrl);
  const assets = [...new Map(images.map((row) => [row.asset.id, row.asset])).values()];
  const category = input.parserResult.section?.trim();
  const candidate: ProcessedCandidate = {
    articleId: articleId(source.id, canonicalUrl),
    sourceId: source.id,
    sourceName: source.name,
    language: normalizedLanguage(input.parserResult.language, source.language),
    sourceUrl: input.canonicalUrl,
    canonicalUrl,
    title: input.parserResult.headline.trim(),
    rawPageObject: input.recordObject,
    captureStatus: "captured",
    assets,
    contentStatus: "full",
    publishedAt: new Date(input.parserResult.publishedAt).toISOString(),
    ...(input.parserResult.modifiedAt ? { updatedAt: new Date(input.parserResult.modifiedAt).toISOString() } : {}),
    authors: [...new Set(input.parserResult.authors.map((author) => author.name.trim()).filter(Boolean))],
    publisherCategories: category ? [category] : [],
    publisherSections: publisherSections(source, category),
    processedBody: body,
    parserVersion: input.parserResult.extraction.parserVersion,
  };
  return {
    formatVersion: PREPARED_FORMAT,
    sourceRawRevision: input.rawRevision,
    rawRunId: input.rawRunId,
    rawRunManifest: input.rawRunManifest,
    recordObject: input.recordObject,
    provider: input.captureRecord.selectedCandidate.provider,
    retrievedAt: input.captureRecord.retrievedAt,
    candidate,
  };
}

function preferredPrepared(left: PreparedArchiveRow, right: PreparedArchiveRow): PreparedArchiveRow {
  const leftBody = left.candidate.processedBody?.length ?? 0;
  const rightBody = right.candidate.processedBody?.length ?? 0;
  if (leftBody !== rightBody) return leftBody > rightBody ? left : right;
  const leftAssets = left.candidate.assets?.length ?? 0;
  const rightAssets = right.candidate.assets?.length ?? 0;
  if (leftAssets !== rightAssets) return leftAssets > rightAssets ? left : right;
  if (left.retrievedAt !== right.retrievedAt) return left.retrievedAt > right.retrievedAt ? left : right;
  return left.recordObject.localeCompare(right.recordObject) <= 0 ? left : right;
}

export function deduplicatePreparedRows(rows: readonly PreparedArchiveRow[]): PreparedArchiveRow[] {
  const selected = new Map<string, PreparedArchiveRow>();
  for (const row of rows) {
    if (row.formatVersion !== PREPARED_FORMAT) throw new Error(`Unsupported prepared archive row: ${String(row.formatVersion)}`);
    const key = `${row.candidate.sourceId}\0${normalizeArticleUrl(row.candidate.canonicalUrl)}`;
    const previous = selected.get(key);
    selected.set(key, previous ? preferredPrepared(previous, row) : row);
  }
  return [...selected.values()].sort((left, right) => (
    left.candidate.sourceId.localeCompare(right.candidate.sourceId)
    || left.candidate.canonicalUrl.localeCompare(right.candidate.canonicalUrl)
    || left.recordObject.localeCompare(right.recordObject)
  ));
}

export function archiveAssetObjects(rows: readonly PreparedArchiveRow[]): string[] {
  return [...new Set(rows.flatMap((row) => row.candidate.assets?.map((asset) => asset.rawObject) ?? []))].sort();
}

export function affectedCanonicalDateObjects(rows: readonly PreparedArchiveRow[]): string[] {
  return [...new Set(rows.map((row) => {
    const date = new Date(row.candidate.publishedAt).toISOString().slice(0, 10);
    return `canonical/${row.candidate.sourceId}/dates/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.json.gz`;
  }))].sort();
}

export async function writeArchiveCanonical(options: {
  workspace: string;
  rows: readonly PreparedArchiveRow[];
  sources: readonly SourceConfig[];
  rawRevision: string;
}): Promise<CanonicalWriteResult[]> {
  if (!options.rawRevision.trim()) throw new Error("Canonical Raw revision must be non-empty");
  const rows = deduplicatePreparedRows(options.rows);
  const bySource = new Map<string, PreparedArchiveRow[]>();
  for (const row of rows) bySource.set(row.candidate.sourceId, [...(bySource.get(row.candidate.sourceId) ?? []), row]);
  const results: CanonicalWriteResult[] = [];
  for (const [sourceId, batch] of [...bySource].sort(([left], [right]) => left.localeCompare(right))) {
    const source = archiveSourceConfig(sourceId, options.sources);
    const runIds = new Set(batch.map((row) => row.rawRunId));
    const manifests = new Set(batch.map((row) => row.rawRunManifest));
    if (runIds.size !== 1 || manifests.size !== 1) throw new Error(`${sourceId}: archive batch mixes Raw runs`);
    const retrieved = batch.map((row) => new Date(row.retrievedAt).toISOString()).sort();
    const providers = [...new Set(batch.map((row) => row.provider))].sort();
    const manifest: SourceCaptureManifest = {
      formatVersion: "jojo-times-raw-source-run/2",
      runId: batch[0]!.rawRunId,
      sourceId,
      sourceName: source.name,
      publicationTimeZone: source.publicationTimeZone,
      startedAt: retrieved[0]!,
      completedAt: retrieved.at(-1)!,
      discovery: { kind: "historical-archive", providers, recordCount: batch.length },
      candidateCount: batch.length,
      fullCount: batch.length,
      summaryCount: 0,
      metadataCount: 0,
      networkExchangeCount: 0,
      objects: [],
      captureStatus: "pages-complete",
      healthStatus: "healthy",
      complete: true,
    };
    results.push(await writeCanonicalSource(
      options.workspace,
      source,
      manifest,
      batch[0]!.rawRunManifest,
      batch.map((row) => row.candidate),
      options.rawRevision,
    ));
  }
  return results;
}
