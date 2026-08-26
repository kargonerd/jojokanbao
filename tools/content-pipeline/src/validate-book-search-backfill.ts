import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import {
  JoxClient,
  asJojoBookSearchIndex,
  asJojoFragment,
  asJojoItemManifest,
  resolveJoxObject,
  transformJoxBytes,
  type JojoBookSearchBlock,
  type JojoCanonicalChapter,
  type JojoItemManifest,
} from "@jojo/content";
import { retryingFetch, type BookSearchBackfillReport } from "./backfill-book-search";
import { bookSearchIndex } from "./search";

export interface ValidateBookSearchBackfillOptions {
  outputDirectory: string;
  contentCdnBase?: string;
  fetchFn?: typeof fetch;
  verifySource?: boolean;
  verifyPublished?: boolean;
  onProgress?: (message: string) => void;
}

export interface BookSearchBackfillValidation {
  items: number;
  chapters: number;
  blocks: number;
  anchoredBlocks: number;
  fallbackBlocks: number;
  searchBytes: number;
  publishedObjects: number;
  publishedBytes: number;
  errors: string[];
}

interface DecodedJox<T> {
  protected: Uint8Array;
  clear: Uint8Array;
  value: T;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function stagedJox<T>(root: string, objectKey: string): Promise<DecodedJox<T>> {
  const protectedBytes = new Uint8Array(
    await readFile(path.join(root, ...objectKey.split("/"))),
  );
  const compressed = transformJoxBytes(protectedBytes, objectKey);
  const clear = new Uint8Array(gunzipSync(compressed));
  return {
    protected: protectedBytes,
    clear,
    value: JSON.parse(Buffer.from(clear).toString("utf8")) as T,
  };
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  task: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await task(values[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function canonicalChapter(fragment: ReturnType<typeof asJojoFragment>): JojoCanonicalChapter {
  return {
    id: fragment.fragmentId,
    order: fragment.order,
    title: fragment.title,
    body: fragment.body,
    assetRefs: fragment.assetRefs,
  };
}

function sameBlock(left: JojoBookSearchBlock, right: JojoBookSearchBlock): boolean {
  return left.targetId === right.targetId
    && left.anchorId === right.anchorId
    && left.order === right.order
    && left.text === right.text;
}

export async function validateBookSearchBackfill(
  options: ValidateBookSearchBackfillOptions,
): Promise<BookSearchBackfillValidation> {
  const root = path.resolve(options.outputDirectory);
  const report = JSON.parse(
    await readFile(path.join(root, "backfill-report.json"), "utf8"),
  ) as BookSearchBackfillReport;
  if (report.formatVersion !== "jojo-book-search-backfill/1") {
    throw new Error("backfill-report.json 格式无效");
  }
  const jox = new JoxClient(
    options.contentCdnBase ?? report.sourceCdnBase,
    retryingFetch(options.fetchFn ?? fetch),
  );
  const errors: string[] = [];
  let chapters = 0;
  let blocks = 0;
  let anchoredBlocks = 0;
  let fallbackBlocks = 0;
  let searchBytes = 0;
  let publishedObjects = 0;
  let publishedBytes = 0;
  let completed = 0;

  await mapConcurrent(report.backfilledItems, 3, async (entry) => {
    const manifestDecoded = await stagedJox<JojoItemManifest>(root, entry.manifestObject);
    const manifest = asJojoItemManifest(manifestDecoded.value);
    const searchDecoded = await stagedJox<unknown>(root, entry.searchObject);
    const search = asJojoBookSearchIndex(searchDecoded.value);
    const descriptors = manifest.content.chapters ?? [];
    const label = `${entry.datasetId}/${entry.itemId}`;

    if (manifest.itemId !== entry.itemId) errors.push(`${label}: Manifest itemId 不一致`);
    if (manifest.datasetId !== entry.datasetId) errors.push(`${label}: Manifest datasetId 不一致`);
    if (!manifest.search) {
      errors.push(`${label}: Manifest 缺少 Search descriptor`);
    } else {
      const resolvedSearch = resolveJoxObject(entry.manifestObject, manifest.search.object);
      if (resolvedSearch !== entry.searchObject) errors.push(`${label}: Search object 路径不一致`);
      if (manifest.search.profile !== "jojo-book-search/1") errors.push(`${label}: Search profile 无效`);
      if (manifest.search.size !== searchDecoded.clear.length) errors.push(`${label}: Search size 不一致`);
      if (manifest.search.sha256 !== sha256(searchDecoded.clear)) errors.push(`${label}: Search SHA-256 不一致`);
    }
    if (search.itemId !== manifest.itemId) errors.push(`${label}: Search itemId 不一致`);
    if (entry.chapterCount !== descriptors.length) errors.push(`${label}: 报告章节数不一致`);
    if (entry.blockCount !== search.blocks.length) errors.push(`${label}: 报告块数不一致`);
    if (entry.searchSize !== searchDecoded.clear.length) errors.push(`${label}: 报告 Search size 不一致`);
    const targetIds = new Set(descriptors.map((descriptor) => descriptor.id));
    if (search.blocks.some((block) => !targetIds.has(block.targetId))) {
      errors.push(`${label}: Search 含不存在的 targetId`);
    }
    if (search.blocks.some((block, index) => block.order !== index + 1)) {
      errors.push(`${label}: Search block order 不连续`);
    }

    if (options.verifySource ?? true) {
      const sourceChapters = await mapConcurrent(descriptors, 4, async (descriptor) => {
        const objectKey = resolveJoxObject(entry.manifestObject, descriptor.object);
        const fragment = asJojoFragment(await jox.fetchJson(objectKey, undefined, "no-store"));
        if (fragment.itemId !== manifest.itemId || fragment.fragmentId !== descriptor.id) {
          errors.push(`${label}: 章节身份不一致 ${objectKey}`);
        }
        return canonicalChapter(fragment);
      });
      const expected = bookSearchIndex({ itemId: manifest.itemId, chapters: sourceChapters });
      if (expected.blocks.length !== search.blocks.length) {
        errors.push(`${label}: Search 与线上章节重建块数不一致`);
      } else {
        const mismatch = expected.blocks.findIndex((block, index) => (
          !sameBlock(block, search.blocks[index]!)
        ));
        if (mismatch >= 0) errors.push(`${label}: Search 与线上章节在 block ${mismatch + 1} 不一致`);
      }
    }

    if (options.verifyPublished) {
      const publishedManifest = await jox.fetchBytes(entry.manifestObject, undefined, "no-store");
      const publishedSearch = await jox.fetchBytes(entry.searchObject, undefined, "no-store");
      if (publishedManifest.length !== manifestDecoded.protected.length
        || sha256(publishedManifest) !== sha256(manifestDecoded.protected)) {
        errors.push(`${label}: CDN Manifest 与待发布文件不一致`);
      }
      if (publishedSearch.length !== searchDecoded.protected.length
        || sha256(publishedSearch) !== sha256(searchDecoded.protected)) {
        errors.push(`${label}: CDN Search 与待发布文件不一致`);
      }
      publishedObjects += 2;
      publishedBytes += publishedManifest.length + publishedSearch.length;
    }

    chapters += descriptors.length;
    blocks += search.blocks.length;
    anchoredBlocks += search.blocks.filter((block) => Boolean(block.anchorId)).length;
    fallbackBlocks += search.blocks.filter((block) => !block.anchorId).length;
    searchBytes += searchDecoded.clear.length;
    completed += 1;
    options.onProgress?.(`[${completed}/${report.backfilledItems.length}] ${entry.itemTitle}`);
  });

  return {
    items: report.backfilledItems.length,
    chapters,
    blocks,
    anchoredBlocks,
    fallbackBlocks,
    searchBytes,
    publishedObjects,
    publishedBytes,
    errors,
  };
}
