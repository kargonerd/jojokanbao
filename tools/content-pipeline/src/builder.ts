import { createHash } from "node:crypto";
import {
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
  transformJoxBytes,
  type JojoCanonicalAsset,
  type JojoCanonicalChapter,
  type JojoCanonicalDataset,
  type JojoCanonicalItem,
  type JojoCatalog,
  type JojoDatasetIndex,
  type JojoFragment,
  type JojoItemManifest,
} from "@jojo/content";
import { buildEpub } from "./epub";
import { decodeEbookFile, isEbookPath } from "./ebook";
import {
  groupBookTitle,
  pruneToc,
  splitChapterRanges,
} from "./grouping";
import type {
  BuiltItemSummary,
  DecodedWereadBook,
  NormalizedBookPart,
  PipelineDiagnostic,
  PipelineReport,
  WereadRawExport,
} from "./models";
import { bookSearchIndex, chapterSearchDocuments, type JojoSearchDocument } from "./search";
import { convertWereadChapter, htmlToText } from "./semantic-html";
import { decodeWereadFile, inspectWereadCompleteness, isWereadExport } from "./weread";

export interface BuildPipelineOptions {
  inputPaths: string[];
  outputDirectory: string;
  fetchAssets?: boolean;
  allowPartial?: boolean;
  publicationStatus?: "draft" | "published";
  access?: "public" | "authenticated";
  fetchFn?: typeof fetch;
  now?: () => Date;
  onProgress?: (event: Record<string, unknown>) => void;
}

interface InspectedSource {
  path: string;
  fileName: string;
  sourceBookId: string;
  title: string;
  exportedAt: number;
  chapterCoverage: number;
  presentChapterRecords: number;
  missingChapterRecords: number;
  sourceTocItems: number;
  missingTocItems: number;
  sourceKind: DecodedWereadBook["sourceKind"];
  decoded?: DecodedWereadBook;
}

interface DatasetBuildState {
  datasetId: string;
  title: string;
  type: "book" | "book-series";
  language: string;
  description: string;
  items: BuiltItemSummary[];
  itemSummaries: NonNullable<JojoDatasetIndex["items"]>;
}

const MAX_ASSET_BYTES = 64 * 1024 * 1024;

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function opaqueName(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("base64url").slice(0, 18);
}

function safeFileName(value: string): string {
  return value.normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/g, "")
    .trim() || "untitled";
}

async function ensureFreshDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  if ((await readdir(directory)).length > 0) {
    throw new Error(`输出目录必须为空：${directory}`);
  }
}

async function writeJson(file: string, value: unknown): Promise<Uint8Array> {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
  return bytes;
}

async function writeGzipJson(file: string, value: unknown): Promise<Uint8Array> {
  const clear = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  const compressed = gzipSync(clear, { level: 9 });
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, compressed);
  return compressed;
}

async function writeJoxJson(
  deliveryRoot: string,
  objectKey: string,
  value: unknown,
): Promise<{ size: number; sha256: string }> {
  const clear = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  const compressed = gzipSync(clear, { level: 9 });
  const protectedBytes = transformJoxBytes(compressed, objectKey);
  const target = path.join(deliveryRoot, ...objectKey.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, protectedBytes);
  return { size: clear.length, sha256: sha256(clear) };
}

async function writeJoxBytes(
  deliveryRoot: string,
  objectKey: string,
  clear: Uint8Array,
): Promise<{ size: number; sha256: string }> {
  const target = path.join(deliveryRoot, ...objectKey.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, transformJoxBytes(clear, objectKey));
  return { size: clear.length, sha256: sha256(clear) };
}

function rawMetadata(raw: WereadRawExport): Record<string, unknown> {
  if (!raw.meta || typeof raw.meta !== "object") return {};
  const data = raw.meta.data;
  if (Array.isArray(data) && data[0] && typeof data[0] === "object") {
    const first = data[0] as Record<string, unknown>;
    return first.book && typeof first.book === "object"
      ? first.book as Record<string, unknown>
      : first;
  }
  return raw.meta.book && typeof raw.meta.book === "object"
    ? raw.meta.book as Record<string, unknown>
    : raw.meta;
}

async function inspectSource(sourcePath: string): Promise<InspectedSource | undefined> {
  if (isEbookPath(sourcePath)) {
    const decoded = await decodeEbookFile(sourcePath);
    return {
      path: path.resolve(sourcePath),
      fileName: path.basename(sourcePath),
      sourceBookId: decoded.sourceBookId,
      title: decoded.title,
      exportedAt: Date.parse(decoded.exportedAt) || 0,
      chapterCoverage: decoded.diagnostics.chapterCoverage,
      presentChapterRecords: decoded.diagnostics.presentChapterRecords,
      missingChapterRecords: decoded.diagnostics.missingChapterRecords,
      sourceTocItems: decoded.diagnostics.sourceTocItems,
      missingTocItems: decoded.diagnostics.missingTocItems,
      sourceKind: decoded.sourceKind,
      decoded,
    };
  }
  const raw = JSON.parse(await readFile(sourcePath, "utf8")) as unknown;
  if (!isWereadExport(raw)) return undefined;
  const metadata = rawMetadata(raw);
  const completeness = inspectWereadCompleteness(raw);
  return {
    path: path.resolve(sourcePath),
    fileName: path.basename(sourcePath),
    sourceBookId: String(raw.bookId),
    title: String(metadata.title || path.basename(sourcePath, path.extname(sourcePath))),
    exportedAt: Number(raw.date) || 0,
    chapterCoverage: completeness.chapterCoverage,
    presentChapterRecords: completeness.presentChapterRecords,
    missingChapterRecords: completeness.missingChapterRecords,
    sourceTocItems: raw.toc?.length ?? 0,
    missingTocItems: completeness.missingTocItems,
    sourceKind: "weread",
  };
}

function selectedSources(
  sources: InspectedSource[],
): { selected: InspectedSource[]; duplicates: InspectedSource[] } {
  const selected = new Map<string, InspectedSource>();
  const duplicates: InspectedSource[] = [];
  for (const source of sources) {
    const key = `${source.sourceKind}:${source.sourceBookId}`;
    const existing = selected.get(key);
    if (!existing) {
      selected.set(key, source);
      continue;
    }
    const sourceQuality = [
      source.presentChapterRecords,
      source.sourceTocItems,
      -source.missingTocItems,
      -source.missingChapterRecords,
      source.chapterCoverage,
      source.exportedAt,
    ];
    const existingQuality = [
      existing.presentChapterRecords,
      existing.sourceTocItems,
      -existing.missingTocItems,
      -existing.missingChapterRecords,
      existing.chapterCoverage,
      existing.exportedAt,
    ];
    const sourceIsBetter = sourceQuality.some((value, index) => (
      value !== existingQuality[index]
      && value > existingQuality[index]!
      && sourceQuality.slice(0, index).every((candidate, earlier) => candidate === existingQuality[earlier])
    ));
    if (sourceIsBetter) {
      duplicates.push(existing);
      selected.set(key, source);
    } else {
      duplicates.push(source);
    }
  }
  return { selected: [...selected.values()], duplicates };
}

function extensionForMediaType(mediaType: string): string {
  const extensions: Record<string, string> = {
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/svg+xml": ".svg",
    "image/webp": ".webp",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/ogg": ".ogg",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
  };
  return extensions[mediaType.split(";", 1)[0]!.toLowerCase()] ?? ".bin";
}

function sniffMediaType(bytes: Uint8Array, header: string | null, fallback: string): string {
  const declared = header?.split(";", 1)[0]?.toLowerCase();
  if (/^(?:image|audio|video)\//.test(declared ?? "")) return declared!;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (String.fromCharCode(...bytes.slice(0, 6)) === "GIF89a") return "image/gif";
  if (String.fromCharCode(...bytes.slice(0, 4)) === "RIFF") return "image/webp";
  return fallback;
}

function permittedAssetUrl(value: string): boolean {
  if (/^data:(?:image|audio|video)\/[a-z0-9.+-]+;base64,/i.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && ["qq.com", "qcloud.com"].some((suffix) => (
        url.hostname === suffix || url.hostname.endsWith(`.${suffix}`)
      ));
  } catch {
    return false;
  }
}

async function downloadAsset(
  asset: JojoCanonicalAsset,
  datasetDirectory: string,
  fetchFn: typeof fetch,
): Promise<JojoCanonicalAsset> {
  if (!asset.sourceUrl || !permittedAssetUrl(asset.sourceUrl)) {
    throw new Error("不允许的资源地址");
  }
  const isEmbedded = asset.sourceUrl.startsWith("data:");
  const response = await fetchFn(asset.sourceUrl, {
    headers: isEmbedded ? undefined : {
      Referer: "https://weread.qq.com/",
      "User-Agent": "JOJO-Content-Pipeline/1.0",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") || "0");
  if (declared > MAX_ASSET_BYTES) throw new Error("资源超过 64 MiB 限制");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_ASSET_BYTES) throw new Error("资源超过 64 MiB 限制");
  const mediaType = sniffMediaType(bytes, response.headers.get("content-type"), asset.mediaType);
  const digest = sha256(bytes);
  const relativePath = `assets/${digest}${extensionForMediaType(mediaType)}`;
  const target = path.join(datasetDirectory, ...relativePath.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await stat(target);
  } catch {
    await writeFile(target, bytes);
  }
  return { ...asset, mediaType, path: relativePath, size: bytes.length, sha256: digest };
}

function removeMissingAssets(
  chapter: JojoCanonicalChapter,
  missing: Set<string>,
): JojoCanonicalChapter {
  let value = chapter.body.value;
  for (const assetId of missing) {
    const escaped = assetId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    value = value.replace(
      new RegExp(`<figure[^>]*data-asset-id=["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/figure>`, "gi"),
      (_whole, inner: string) => inner.replace(/<\/?figcaption>/gi, ""),
    );
    value = value.replace(
      new RegExp(`<span[^>]*data-asset-id=["']${escaped}["'][^>]*><\\/span>`, "gi"),
      "",
    );
  }
  return {
    ...chapter,
    body: { ...chapter.body, value },
    assetRefs: chapter.assetRefs.filter((id) => !missing.has(id)),
  };
}

function authors(book: DecodedWereadBook): string[] {
  return book.author.trim() ? [book.author.trim()] : [];
}

function buildParts(
  source: DecodedWereadBook,
  chapters: JojoCanonicalChapter[],
  assets: JojoCanonicalAsset[],
  annotations: NormalizedBookPart["annotations"],
  totalVolumesForDataset?: number,
): NormalizedBookPart[] {
  const grouping = groupBookTitle(source.title);
  const ranges = grouping.sourcePartKey
    ? []
    : splitChapterRanges(chapters, source.toc, grouping.declaredTotalVolumes);
  const makePart = (
    itemKey: string,
    itemTitle: string,
    itemOrder: number,
    chapterIds: Set<string>,
    volumeNumber?: number,
    totalVolumes?: number,
  ): NormalizedBookPart => {
    const selectedChapters = chapters.filter((chapter) => chapterIds.has(chapter.id));
    const referencedAssets = new Set(selectedChapters.flatMap((chapter) => chapter.assetRefs));
    for (const asset of assets) if (asset.role === "cover") referencedAssets.add(asset.id);
    return {
      datasetId: grouping.datasetId,
      datasetTitle: grouping.datasetTitle,
      datasetType: grouping.datasetType,
      itemId: `${grouping.datasetId}:${itemKey}`,
      itemKey,
      itemType: volumeNumber ? "book-volume" : "book",
      itemTitle,
      itemOrder,
      ...(volumeNumber ? { volumeNumber } : {}),
      ...(totalVolumes ? { totalVolumes } : {}),
      source,
      chapters: selectedChapters,
      toc: pruneToc(source.toc, chapterIds),
      assets: assets.filter((asset) => referencedAssets.has(asset.id)),
      annotations: annotations.filter((annotation) => chapterIds.has(annotation.targetId)),
    };
  };
  if (ranges.length > 1) {
    const total = grouping.declaredTotalVolumes ?? ranges.length;
    return ranges.map((range) => makePart(
      `volume-${range.volumeNumber}`,
      `${grouping.datasetTitle} 第${range.volumeNumber}卷`,
      range.volumeNumber,
      range.chapterIds,
      range.volumeNumber,
      total,
    ));
  }
  const allIds = new Set(chapters.map((chapter) => chapter.id));
  if (grouping.sourceVolumeNumber) {
    return [makePart(
      `volume-${grouping.sourceVolumeNumber}`,
      source.title,
      grouping.sourceVolumeNumber,
      allIds,
      grouping.sourceVolumeNumber,
      totalVolumesForDataset,
    )];
  }
  if (grouping.sourcePartKey) {
    return [makePart(
      grouping.sourcePartKey,
      source.title,
      grouping.sourcePartOrder ?? 1,
      allIds,
    )];
  }
  return [makePart("full-book", source.title, 1, allIds)];
}

async function buildItem(
  part: NormalizedBookPart,
  roots: { canonical: string; delivery: string; huggingface: string },
  publicationStatus: "draft" | "published",
  access: "public" | "authenticated",
): Promise<{
  summary: BuiltItemSummary;
  itemSummary: NonNullable<JojoDatasetIndex["items"]>[number];
  search: JojoSearchDocument[];
}> {
  const canonicalDatasetDirectory = path.join(roots.canonical, "books", part.datasetId);
  const canonicalItemDirectory = path.join(canonicalDatasetDirectory, "items", part.itemKey);
  const deliveryItemPrefix = `content/books/${part.datasetId}/items/${part.itemKey}`;
  const manifestObject = `${deliveryItemPrefix}/manifest.jox`;
  const fragmentObjects = new Map<string, string>();
  const chapterDescriptors: NonNullable<JojoItemManifest["content"]["chapters"]> = [];

  for (const chapter of part.chapters) {
    const fragment: JojoFragment = {
      formatVersion: "jojo-fragment/1",
      itemId: part.itemId,
      fragmentId: chapter.id,
      type: "chapter",
      order: chapter.order,
      title: chapter.title,
      body: chapter.body,
      assetRefs: chapter.assetRefs,
      annotations: part.annotations.filter((annotation) => annotation.targetId === chapter.id),
    };
    const clear = Buffer.from(`${JSON.stringify(fragment)}\n`, "utf8");
    const object = `chapters/${opaqueName(clear)}.jox`;
    const fullObject = `${deliveryItemPrefix}/${object}`;
    await writeJoxJson(roots.delivery, fullObject, fragment);
    fragmentObjects.set(chapter.id, fullObject);
    chapterDescriptors.push({
      id: chapter.id,
      order: chapter.order,
      title: chapter.title,
      characterCount: htmlToText(chapter.body.value).length,
      object,
      size: clear.length,
      sha256: sha256(clear),
    });
  }

  const assetDescriptors: JojoItemManifest["assets"] = [];
  for (const asset of part.assets) {
    if (!asset.path) continue;
    const clear = new Uint8Array(await readFile(path.join(canonicalDatasetDirectory, asset.path)));
    const object = `assets/${opaqueName(clear)}.jox`;
    await writeJoxBytes(roots.delivery, `${deliveryItemPrefix}/${object}`, clear);
    const { path: _path, sourceUrl: _sourceUrl, ...descriptor } = asset;
    assetDescriptors.push({ ...descriptor, object });
  }

  const epub = await buildEpub({
    itemId: part.itemId,
    title: part.itemTitle,
    language: part.source.language,
    author: part.source.author,
    chapters: part.chapters,
    toc: part.toc,
    annotations: part.annotations,
    assets: part.assets,
    canonicalDatasetDirectory,
  });
  const exportObject = `exports/${opaqueName(epub)}.jox`;
  const exportInfo = await writeJoxBytes(
    roots.delivery,
    `${deliveryItemPrefix}/${exportObject}`,
    epub,
  );

  const canonical: JojoCanonicalItem = {
    formatVersion: "jojo-item/1",
    revision: 1,
    itemId: part.itemId,
    datasetId: part.datasetId,
    type: part.itemType,
    title: part.itemTitle,
    language: part.source.language,
    publicationStatus,
    access,
    identifiers: { isbn: part.source.isbn || null },
    metadata: {
      authors: authors(part.source),
      publisher: part.source.publisher || null,
      publishedDate: part.source.publishedDate ?? null,
      ...(part.volumeNumber ? { volumeNumber: part.volumeNumber } : {}),
      ...(part.totalVolumes ? { totalVolumes: part.totalVolumes } : {}),
      description: part.source.description,
    },
    content: {
      schema: "jojo-content/book/1",
      toc: part.toc,
      chapters: part.chapters,
    },
    assets: part.assets,
    annotations: part.annotations,
    provenance: {
      source: part.source.sourceKind,
      sourceId: part.source.sourceBookId,
      sourceFormat: part.source.sourceFormat,
      sourceExportedAt: part.source.exportedAt,
      sourceSha256: part.source.sourceSha256,
      importedAt: new Date().toISOString(),
      importer: "@jojo/content-pipeline/0.1.0",
    },
    extensions: {
      [part.source.sourceKind]: part.source.sourceDetails,
    },
  };
  const canonicalObject = `canonical/books/${part.datasetId}/items/${part.itemKey}/item.json.gz`;
  const canonicalGzip = await writeGzipJson(
    path.join(canonicalItemDirectory, "item.json.gz"),
    canonical,
  );
  const characterCount = part.chapters.reduce(
    (sum, chapter) => sum + htmlToText(chapter.body.value).length,
    0,
  );
  const searchObject = "search/text.jox";
  const searchInfo = await writeJoxJson(
    roots.delivery,
    `${deliveryItemPrefix}/${searchObject}`,
    bookSearchIndex({ itemId: part.itemId, chapters: part.chapters }),
  );
  const manifest: JojoItemManifest = {
    formatVersion: "jojo-item-manifest/1",
    revision: 1,
    itemId: part.itemId,
    datasetId: part.datasetId,
    type: part.itemType,
    title: part.itemTitle,
    language: part.source.language,
    publicationStatus,
    access,
    identifiers: canonical.identifiers,
    metadata: canonical.metadata,
    content: {
      schema: "jojo-content/book/1",
      toc: part.toc,
      chapters: chapterDescriptors,
    },
    contentStats: {
      chapterCount: part.chapters.length,
      characterCount,
      canonicalCompressedSize: canonicalGzip.length,
    },
    search: {
      format: "text",
      profile: "jojo-book-search/1",
      object: searchObject,
      ...searchInfo,
    },
    assets: assetDescriptors,
    exports: [{
      id: "export:epub",
      format: "epub",
      mediaType: "application/epub+zip",
      fileName: `${safeFileName(part.itemTitle)}.epub`,
      object: exportObject,
      ...exportInfo,
    }],
  };
  await writeJoxJson(roots.delivery, manifestObject, manifest);

  const hfItemDirectory = path.join(roots.huggingface, part.datasetId, "data");
  await mkdir(hfItemDirectory, { recursive: true });
  await copyFile(
    path.join(canonicalItemDirectory, "item.json.gz"),
    path.join(hfItemDirectory, `${part.itemKey}.json.gz`),
  );

  const search = chapterSearchDocuments({
    datasetId: part.datasetId,
    datasetTitle: part.datasetTitle,
    itemId: part.itemId,
    itemTitle: part.itemTitle,
    itemType: part.itemType,
    authors: authors(part.source),
    ...(part.source.publishedDate ? { publishedDate: part.source.publishedDate } : {}),
    manifestObject,
    fragmentObjects,
    chapters: part.chapters,
  });
  return {
    summary: {
      datasetId: part.datasetId,
      datasetTitle: part.datasetTitle,
      itemId: part.itemId,
      itemKey: part.itemKey,
      itemTitle: part.itemTitle,
      chapters: part.chapters.length,
      characters: characterCount,
      assets: part.assets.length,
      annotations: part.annotations.length,
      manifestObject,
      canonicalObject,
    },
    itemSummary: {
      itemId: part.itemId,
      itemKey: part.itemKey,
      type: part.itemType,
      order: part.itemOrder,
      title: part.itemTitle,
      manifestObject: `items/${part.itemKey}/manifest.jox`,
      publicationStatus,
      access,
    },
    search,
  };
}

function hfReadme(dataset: DatasetBuildState): string {
  return `---
pretty_name: ${dataset.title}
language:
- zh
task_categories:
- text-retrieval
---

# ${dataset.title}

JOJO Canonical 数据集导出。格式为 \`jojo-item/1\`，每个 gzip 文件对应一个可独立阅读的 Item。

- Dataset ID: \`${dataset.datasetId}\`
- 类型: \`${dataset.type}\`
- Item 数量: ${dataset.items.length}
`;
}

export async function buildContentPipeline(
  options: BuildPipelineOptions,
): Promise<PipelineReport> {
  const outputDirectory = path.resolve(options.outputDirectory);
  const publicationStatus = options.publicationStatus ?? "draft";
  const access = options.access ?? "public";
  await ensureFreshDirectory(outputDirectory);
  const roots = {
    raw: path.join(outputDirectory, "raw"),
    canonical: path.join(outputDirectory, "canonical"),
    delivery: path.join(outputDirectory, "delivery"),
    huggingface: path.join(outputDirectory, "huggingface"),
  };
  const diagnostics: PipelineDiagnostic[] = [];
  const inspected: InspectedSource[] = [];
  let rejectedFiles = 0;
  for (const [index, input] of options.inputPaths.entries()) {
    options.onProgress?.({ phase: "inspect", current: index + 1, total: options.inputPaths.length, file: input });
    try {
      const source = await inspectSource(input);
      if (source) inspected.push(source);
      else {
        rejectedFiles += 1;
        diagnostics.push({ level: "warning", code: "unsupported-source", message: "跳过不支持的来源文件", source: input });
      }
    } catch (error) {
      rejectedFiles += 1;
      diagnostics.push({ level: "error", code: "invalid-source", message: error instanceof Error ? error.message : String(error), source: input });
    }
  }
  const { selected, duplicates } = selectedSources(inspected);
  for (const duplicate of duplicates) {
    diagnostics.push({ level: "warning", code: "duplicate-source-book", message: `同一来源书籍 ID 已选择完整度更高或更新的文件，跳过 ${duplicate.fileName}`, source: duplicate.path });
  }

  const volumeCounts = new Map<string, number>();
  for (const source of selected) {
    const grouping = groupBookTitle(source.title);
    if (grouping.sourceVolumeNumber) {
      volumeCounts.set(grouping.datasetId, Math.max(volumeCounts.get(grouping.datasetId) ?? 0, grouping.sourceVolumeNumber));
    }
  }

  const datasets = new Map<string, DatasetBuildState>();
  const allSearch: JojoSearchDocument[] = [];
  const builtItems: BuiltItemSummary[] = [];
  const supersededDatasetIds = new Set<string>();
  const fetchedAssets = new Map<string, JojoCanonicalAsset>();
  const fetchingAssets = new Map<string, Promise<JojoCanonicalAsset>>();
  const pendingParts: NormalizedBookPart[] = [];
  let importedFiles = 0;
  for (const [sourceIndex, inspectedSource] of selected.entries()) {
    options.onProgress?.({ phase: "decode", current: sourceIndex + 1, total: selected.length, file: inspectedSource.fileName });
    const decoded = inspectedSource.decoded ?? await decodeWereadFile(inspectedSource.path);
    let sourceRejected = false;
    if (decoded.diagnostics.missingTocItems > 0) {
      diagnostics.push({
        level: options.allowPartial ? "warning" : "error",
        code: "source-toc-truncated",
        message: `${decoded.title} 目录不完整：元数据声明 ${decoded.diagnostics.declaredTocItems} 项，`
          + `导出文件只有 ${decoded.diagnostics.sourceTocItems} 项，缺少 ${decoded.diagnostics.missingTocItems} 项`,
        source: decoded.sourcePath,
      });
      sourceRejected = !options.allowPartial;
    }
    if (decoded.diagnostics.missingChapterRecords > 0) {
      const firstMissing = decoded.diagnostics.missingChapters
        .slice(0, 3)
        .map((chapter) => `${chapter.order}. ${chapter.title}`)
        .join("；");
      diagnostics.push({
        level: options.allowPartial ? "warning" : "error",
        code: "source-chapters-missing",
        message: `${decoded.title} 正文不完整：目录应有 ${decoded.diagnostics.expectedChapterRecords} 条正文，`
          + `实际匹配 ${decoded.diagnostics.presentChapterRecords} 条，缺少 ${decoded.diagnostics.missingChapterRecords} 条`
          + `${firstMissing ? `（例如：${firstMissing}）` : ""}`,
        source: decoded.sourcePath,
      });
      sourceRejected = !options.allowPartial;
    }
    if (decoded.diagnostics.failedChapterRecords > 0) {
      diagnostics.push({
        level: options.allowPartial ? "warning" : "error",
        code: "chapter-decode-failed",
        message: `${decoded.title} 有 ${decoded.diagnostics.failedChapterRecords} 个章节记录无法解码`,
        source: decoded.sourcePath,
      });
      sourceRejected ||= !options.allowPartial;
    }
    const internalLinks = Number(decoded.sourceDetails.internalLinks ?? 0);
    const resolvedInternalLinks = Number(decoded.sourceDetails.resolvedInternalLinks ?? internalLinks);
    if (resolvedInternalLinks < internalLinks) {
      const examples = decoded.diagnostics.errors
        .filter((entry) => String(entry.error ?? "").includes("内链"))
        .slice(0, 3)
        .map((entry) => `${String(entry.file ?? "未知文件")} → ${String(entry.reference ?? "未知目标")}`)
        .join("；");
      diagnostics.push({
        level: options.allowPartial ? "warning" : "error",
        code: "internal-links-unresolved",
        message: `${decoded.title} 有 ${internalLinks - resolvedInternalLinks}/${internalLinks} 条正文内链无法精确解析`
          + `${examples ? `（${examples}）` : ""}`,
        source: decoded.sourcePath,
      });
      sourceRejected ||= !options.allowPartial;
    }
    if (sourceRejected) {
      rejectedFiles += 1;
      continue;
    }
    importedFiles += 1;
    const semantic = decoded.chapters.map((chapter) => convertWereadChapter(chapter, diagnostics));
    let chapters = semantic.map((entry) => entry.chapter);
    const annotations = semantic.flatMap((entry) => entry.annotations);
    const assetCandidates = new Map<string, JojoCanonicalAsset>();
    for (const asset of semantic.flatMap((entry) => entry.assets)) assetCandidates.set(asset.id, asset);
    if (decoded.coverUrl) {
      assetCandidates.set("asset:cover", {
        id: "asset:cover",
        type: "image",
        role: "cover",
        mediaType: decoded.coverUrl.match(/^data:([^;,]+)/i)?.[1] ?? "image/jpeg",
        path: "",
        sourceUrl: decoded.coverUrl,
        size: 0,
        sha256: "",
        alt: `${decoded.title}封面`,
        caption: null,
      });
    }
    const grouping = groupBookTitle(decoded.title);
    for (const datasetId of grouping.supersededDatasetIds ?? []) {
      supersededDatasetIds.add(datasetId);
    }
    const canonicalDatasetDirectory = path.join(roots.canonical, "books", grouping.datasetId);
    const resolvedAssets: JojoCanonicalAsset[] = [];
    const missingAssets = new Set<string>();
    if (options.fetchAssets !== false) {
      const candidates = [...assetCandidates.values()];
      for (let offset = 0; offset < candidates.length; offset += 8) {
        const batch = candidates.slice(offset, offset + 8);
        const results = await Promise.all(batch.map(async (asset) => {
          try {
            const cacheKey = `${grouping.datasetId}\0${asset.sourceUrl ?? asset.id}`;
            const cached = fetchedAssets.get(cacheKey);
            if (cached) return { asset, resolved: cached };
            let pending = fetchingAssets.get(cacheKey);
            if (!pending) {
              pending = downloadAsset(asset, canonicalDatasetDirectory, options.fetchFn ?? fetch);
              fetchingAssets.set(cacheKey, pending);
            }
            const resolved = await pending;
            fetchedAssets.set(cacheKey, resolved);
            return { asset, resolved };
          } catch (error) {
            return { asset, error };
          }
        }));
        for (const entry of results) {
          if (entry.resolved) {
            resolvedAssets.push({
              ...entry.resolved,
              id: entry.asset.id,
              role: entry.asset.role,
              alt: entry.asset.alt,
              caption: entry.asset.caption,
            });
          } else {
            missingAssets.add(entry.asset.id);
            diagnostics.push({
              level: "warning",
              code: "asset-download-failed",
              message: `${decoded.title}: 资源 ${entry.asset.id} 下载失败 (${entry.error instanceof Error ? entry.error.message : String(entry.error)})`,
              source: decoded.sourcePath,
            });
          }
        }
      }
    } else {
      for (const asset of assetCandidates.values()) missingAssets.add(asset.id);
    }
    if (missingAssets.size > 0) chapters = chapters.map((chapter) => removeMissingAssets(chapter, missingAssets));

    const sourceExtension = path.extname(inspectedSource.fileName).toLowerCase();
    const readableTitle = safeFileName(decoded.title).slice(0, 100);
    const readableSourceId = safeFileName(decoded.sourceBookId).slice(0, 60);
    const readableRawFileName = `${readableTitle}--${readableSourceId}${sourceExtension}`;
    const rawRelativePath = `${decoded.sourceKind}/${readableRawFileName}`;
    const rawTarget = path.join(roots.raw, ...rawRelativePath.split("/"));
    await mkdir(path.dirname(rawTarget), { recursive: true });
    await copyFile(inspectedSource.path, rawTarget);

    const parts = buildParts(
      decoded,
      chapters,
      resolvedAssets,
      annotations,
      volumeCounts.get(grouping.datasetId),
    );
    if (grouping.declaredTotalVolumes && parts.length === 1 && parts[0]?.itemKey === "full-book") {
      diagnostics.push({
        level: "warning",
        code: "volume-boundaries-unproven",
        message: `${decoded.title} 未找到完整且有正文对应的 1–${grouping.declaredTotalVolumes} 卷界，按一个合订 Item 保存`,
        source: decoded.sourcePath,
        itemId: parts[0].itemId,
      });
    }
    pendingParts.push(...parts);
  }

  const sourcePriority: Record<DecodedWereadBook["sourceKind"], number> = { weread: 3, epub: 2, kindle: 1 };
  const selectedParts = new Map<string, NormalizedBookPart>();
  for (const part of pendingParts) {
    const key = `${part.datasetId}\0${part.itemKey}`;
    const existing = selectedParts.get(key);
    if (!existing) {
      selectedParts.set(key, part);
      continue;
    }
    const partQuality = [sourcePriority[part.source.sourceKind], part.annotations.length, part.chapters.length];
    const existingQuality = [sourcePriority[existing.source.sourceKind], existing.annotations.length, existing.chapters.length];
    const usePart = partQuality.some((value, index) => (
      value !== existingQuality[index]
      && value > existingQuality[index]!
      && partQuality.slice(0, index).every((candidate, earlier) => candidate === existingQuality[earlier])
    ));
    const kept = usePart ? part : existing;
    const skipped = usePart ? existing : part;
    selectedParts.set(key, kept);
    diagnostics.push({
      level: "warning",
      code: "duplicate-dataset-item-source",
      message: `${part.itemTitle} 同时存在于 ${existing.source.sourceFormat} 和 ${part.source.sourceFormat}；保留 ${kept.source.sourceFormat}，跳过 ${skipped.source.sourceFormat}`,
      source: skipped.source.sourcePath,
      itemId: skipped.itemId,
    });
  }

  for (const part of [...selectedParts.values()].sort((left, right) => (
    left.datasetTitle.localeCompare(right.datasetTitle, "zh-CN") || left.itemOrder - right.itemOrder
  ))) {
      options.onProgress?.({ phase: "build-item", itemId: part.itemId, title: part.itemTitle });
      const result = await buildItem(part, roots, publicationStatus, access);
      builtItems.push(result.summary);
      allSearch.push(...result.search);
      const state = datasets.get(part.datasetId) ?? {
        datasetId: part.datasetId,
        title: part.datasetTitle,
        type: part.datasetType,
        language: part.source.language,
        description: part.source.description,
        items: [],
        itemSummaries: [],
      };
      state.items.push(result.summary);
      state.itemSummaries.push(result.itemSummary);
      if (state.items.length > 1) state.type = "book-series";
      datasets.set(part.datasetId, state);
  }

  const catalog: JojoCatalog = {
    formatVersion: "jojo-catalog/1",
    revision: 1,
    updatedAt: (options.now?.() ?? new Date()).toISOString(),
    datasets: [],
  };
  for (const dataset of [...datasets.values()].sort((left, right) => left.title.localeCompare(right.title, "zh-CN"))) {
    dataset.itemSummaries.sort((left, right) => left.order - right.order || left.title.localeCompare(right.title, "zh-CN"));
    const index: JojoDatasetIndex = {
      formatVersion: "jojo-delivery-index/1",
      revision: 1,
      datasetId: dataset.datasetId,
      type: dataset.type,
      title: dataset.title,
      language: dataset.language,
      description: dataset.description,
      aiEnabled: true,
      publicationStatus,
      access,
      items: dataset.itemSummaries,
    };
    const canonicalDataset: JojoCanonicalDataset = {
      formatVersion: "jojo-dataset/1",
      datasetId: dataset.datasetId,
      type: dataset.type,
      title: dataset.title,
      language: dataset.language,
      description: dataset.description,
      aiEnabled: true,
      publicationStatus,
      access,
      itemPath: "items/{itemKey}/item.json.gz",
    };
    await writeJson(path.join(roots.canonical, "books", dataset.datasetId, "dataset.json"), canonicalDataset);
    await writeJoxJson(roots.delivery, `content/books/${dataset.datasetId}/index.jox`, index);
    await mkdir(path.join(roots.huggingface, dataset.datasetId), { recursive: true });
    await writeFile(path.join(roots.huggingface, dataset.datasetId, "README.md"), hfReadme(dataset), "utf8");
    await writeJson(path.join(roots.huggingface, dataset.datasetId, "dataset.json"), {
      ...canonicalDataset,
      items: dataset.itemSummaries.map(({ manifestObject: _manifestObject, ...item }) => ({
        ...item,
        path: `data/${item.itemKey}.json.gz`,
      })),
    });
    const canonicalAssets = path.join(roots.canonical, "books", dataset.datasetId, "assets");
    let hasCanonicalAssets = false;
    try {
      await stat(canonicalAssets);
      hasCanonicalAssets = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (hasCanonicalAssets) {
      await cp(canonicalAssets, path.join(roots.huggingface, dataset.datasetId, "assets"), { recursive: true });
    }
    catalog.datasets.push({
      datasetId: dataset.datasetId,
      type: dataset.type,
      title: dataset.title,
      language: dataset.language,
      itemCount: dataset.items.length,
      indexObject: `content/books/${dataset.datasetId}/index.jox`,
      aiEnabled: true,
      publicationStatus,
      access,
    });
  }
  await writeJoxJson(roots.delivery, "catalog.jox", catalog);
  await mkdir(roots.huggingface, { recursive: true });
  await writeFile(
    path.join(roots.huggingface, "README.md"),
    `---\npretty_name: JOJO Canonical Content\nlanguage:\n- zh\ntask_categories:\n- text-retrieval\n---\n\n# JOJO Canonical Content\n\n由 JOJO Content Pipeline 生成的私有规范数据镜像。每个一级目录对应一个用户可识别的 Dataset，来源平台只记录在 Item provenance 中。\n\n${catalog.datasets.map((dataset) => `- \`${dataset.datasetId}\` — ${dataset.title}`).join("\n")}\n`,
    "utf8",
  );
  await mkdir(path.join(outputDirectory, "search"), { recursive: true });
  await writeFile(
    path.join(outputDirectory, "search", "documents.jsonl.gz"),
    gzipSync(Buffer.from(`${allSearch.map((document) => JSON.stringify(document)).join("\n")}\n`), { level: 9 }),
  );
  const report: PipelineReport = {
    formatVersion: "jojo-pipeline-report/1",
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    inputFiles: options.inputPaths.length,
    acceptedFiles: importedFiles,
    rejectedFiles,
    duplicateFiles: duplicates.length,
    datasets: datasets.size,
    items: builtItems.length,
    chapters: builtItems.reduce((sum, item) => sum + item.chapters, 0),
    searchDocuments: allSearch.length,
    assets: builtItems.reduce((sum, item) => sum + item.assets, 0),
    annotations: builtItems.reduce((sum, item) => sum + item.annotations, 0),
    outputDirectory,
    catalogObject: "delivery/catalog.jox",
    supersededDatasetIds: [...supersededDatasetIds].sort(),
    itemsBuilt: builtItems,
    diagnostics,
  };
  await writeJson(path.join(outputDirectory, "report.json"), report);
  options.onProgress?.({ phase: "complete", report });
  return report;
}
