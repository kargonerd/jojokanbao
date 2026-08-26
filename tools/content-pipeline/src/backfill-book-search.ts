import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
  JoxClient,
  asJojoCatalog,
  asJojoDatasetIndex,
  asJojoFragment,
  asJojoItemManifest,
  resolveJoxObject,
  supportsJojoDatasetAi,
  transformJoxBytes,
  gunzipJoxJson,
  bookSearchBlockAnchorId,
  type JojoBookSearchIndex,
  type JojoCanonicalChapter,
  type JojoItemManifest,
} from "@jojo/content";
import { bookSearchIndex } from "./search";

interface BackfilledItem {
  datasetId: string;
  datasetTitle: string;
  itemId: string;
  itemTitle: string;
  manifestObject: string;
  searchObject: string;
  chapterCount: number;
  blockCount: number;
  searchSize: number;
}

export interface BookSearchBackfillReport {
  formatVersion: "jojo-book-search-backfill/1";
  sourceCdnBase: string;
  createdAt: string;
  selectedDatasetCount: number;
  selectedItemCount: number;
  skippedExistingCount: number;
  backfilledItems: BackfilledItem[];
}

export interface BuildBookSearchBackfillOptions {
  contentCdnBase: string;
  outputDirectory: string;
  datasetIds?: string[];
  force?: boolean;
  resume?: boolean;
  fetchFn?: typeof fetch;
  onProgress?: (message: string) => void;
}

async function prepareOutputDirectory(directory: string, resume: boolean): Promise<void> {
  await mkdir(directory, { recursive: true });
  if (!resume && (await readdir(directory)).length) {
    throw new Error(`输出目录必须为空：${directory}`);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeJoxJson(
  root: string,
  objectKey: string,
  value: unknown,
): Promise<{ size: number; sha256: string }> {
  const clear = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  const protectedBytes = transformJoxBytes(gzipSync(clear, { level: 9 }), objectKey);
  const target = path.join(root, ...objectKey.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, protectedBytes);
  return { size: clear.length, sha256: sha256(clear) };
}

async function readStagedJox<T>(
  root: string,
  objectKey: string,
): Promise<T | undefined> {
  try {
    return await gunzipJoxJson<T>(
      new Uint8Array(await readFile(path.join(root, ...objectKey.split("/")))),
      objectKey,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  task: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await task(values[index]!);
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

export function retryingFetch(fetchFn: typeof fetch): typeof fetch {
  return async (input, init) => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const response = await fetchFn(input, init);
        if (response.ok) {
          const body = await response.arrayBuffer();
          return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
        if (response.status !== 429 && response.status < 500) return response;
        lastError = new Error(`CDN returned retryable HTTP ${response.status}`);
        await response.body?.cancel().catch(() => undefined);
      } catch (error) {
        lastError = error;
      }
      if (init?.signal?.aborted) throw lastError;
      await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };
}

export async function buildBookSearchBackfill(
  options: BuildBookSearchBackfillOptions,
): Promise<BookSearchBackfillReport> {
  await prepareOutputDirectory(options.outputDirectory, options.resume ?? false);
  const jox = new JoxClient(
    options.contentCdnBase,
    retryingFetch(options.fetchFn ?? fetch),
  );
  const requested = new Set(options.datasetIds ?? []);
  const catalog = asJojoCatalog(
    await jox.fetchJson("catalog.jox", undefined, "no-store"),
  );
  const datasets = catalog.datasets.filter((entry) => (
    supportsJojoDatasetAi(entry)
    && (entry.type === "book" || entry.type === "book-series")
    && entry.publicationStatus !== "draft"
    && (!requested.size || requested.has(entry.datasetId))
  ));
  if (requested.size) {
    const found = new Set(datasets.map((entry) => entry.datasetId));
    const missing = [...requested].filter((datasetId) => !found.has(datasetId));
    if (missing.length) throw new Error(`Dataset 不存在或不支持 AI：${missing.join("、")}`);
  }

  let selectedItemCount = 0;
  let skippedExistingCount = 0;
  const backfilledItems: BackfilledItem[] = [];
  for (const [datasetOffset, entry] of datasets.entries()) {
    options.onProgress?.(`[${datasetOffset + 1}/${datasets.length}] ${entry.title}`);
    const indexObject = entry.indexObject;
    const index = asJojoDatasetIndex(await jox.fetchJson(indexObject));
    if (index.datasetId !== entry.datasetId) {
      throw new Error(`Dataset Index 不匹配：${entry.datasetId}`);
    }
    for (const item of index.items.filter((candidate) => candidate.publicationStatus !== "draft")) {
      selectedItemCount += 1;
      const manifestObject = resolveJoxObject(indexObject, item.manifestObject);
      const manifest = asJojoItemManifest(
        await jox.fetchJson<JojoItemManifest>(manifestObject, undefined, "no-store"),
      );
      if (manifest.search && !options.force) {
        skippedExistingCount += 1;
        continue;
      }
      const descriptors = manifest.content.chapters ?? [];
      if (!descriptors.length) throw new Error(`书籍没有章节：${manifest.itemId}`);
      const searchObject = resolveJoxObject(manifestObject, "search/text.jox");
      if (options.resume) {
        const stagedManifest = await readStagedJox<JojoItemManifest>(
          options.outputDirectory,
          manifestObject,
        );
        const stagedSearch = await readStagedJox<JojoBookSearchIndex>(
          options.outputDirectory,
          searchObject,
        );
        if (stagedManifest || stagedSearch) {
          if (
            stagedManifest?.itemId !== manifest.itemId
            || stagedManifest.search?.object !== "search/text.jox"
            || stagedSearch?.itemId !== manifest.itemId
          ) {
            throw new Error(`暂存断点不完整或不匹配：${manifest.itemId}`);
          }
          let resumedSearch = stagedSearch;
          let resumedManifest = stagedManifest;
          let changed = false;
          const chapterBlockNumbers = new Map<string, number>();
          resumedSearch = {
            ...resumedSearch,
            blocks: resumedSearch.blocks.map((block) => {
              const blockNumber = (chapterBlockNumbers.get(block.targetId) ?? 0) + 1;
              chapterBlockNumbers.set(block.targetId, blockNumber);
              if (block.anchorId) return block;
              changed = true;
              return {
                ...block,
                anchorId: bookSearchBlockAnchorId(block.targetId, blockNumber),
              };
            }),
          };
          if (changed) {
            const searchInfo = await writeJoxJson(options.outputDirectory, searchObject, resumedSearch);
            resumedManifest = {
              ...resumedManifest,
              search: {
                format: "text",
                profile: "jojo-book-search/1",
                object: "search/text.jox",
                ...searchInfo,
              },
            };
            await writeJoxJson(options.outputDirectory, manifestObject, resumedManifest);
          }
          backfilledItems.push({
            datasetId: entry.datasetId,
            datasetTitle: entry.title,
            itemId: manifest.itemId,
            itemTitle: manifest.title,
            manifestObject,
            searchObject,
            chapterCount: descriptors.length,
            blockCount: resumedSearch.blocks.length,
            searchSize: resumedManifest.search!.size,
          });
          options.onProgress?.(`  = ${manifest.title}: ${changed ? "已补稳定锚点" : "已校验暂存断点"}`);
          continue;
        }
      }
      const chapters = await mapConcurrent(descriptors, 4, async (descriptor) => {
        const fragmentObject = resolveJoxObject(manifestObject, descriptor.object);
        const fragment = asJojoFragment(await jox.fetchJson(fragmentObject));
        if (fragment.itemId !== manifest.itemId || fragment.fragmentId !== descriptor.id) {
          throw new Error(`章节与 Manifest 不匹配：${fragmentObject}`);
        }
        return canonicalChapter(fragment);
      });
      const search: JojoBookSearchIndex = bookSearchIndex({
        itemId: manifest.itemId,
        chapters,
      });
      const searchInfo = await writeJoxJson(options.outputDirectory, searchObject, search);
      const updatedManifest: JojoItemManifest = {
        ...manifest,
        revision: manifest.revision + 1,
        search: {
          format: "text",
          profile: "jojo-book-search/1",
          object: "search/text.jox",
          ...searchInfo,
        },
      };
      await writeJoxJson(options.outputDirectory, manifestObject, updatedManifest);
      backfilledItems.push({
        datasetId: entry.datasetId,
        datasetTitle: entry.title,
        itemId: manifest.itemId,
        itemTitle: manifest.title,
        manifestObject,
        searchObject,
        chapterCount: chapters.length,
        blockCount: search.blocks.length,
        searchSize: searchInfo.size,
      });
      options.onProgress?.(`  + ${manifest.title}: ${search.blocks.length} blocks`);
    }
  }
  const report: BookSearchBackfillReport = {
    formatVersion: "jojo-book-search-backfill/1",
    sourceCdnBase: options.contentCdnBase,
    createdAt: new Date().toISOString(),
    selectedDatasetCount: datasets.length,
    selectedItemCount,
    skippedExistingCount,
    backfilledItems,
  };
  await writeFile(
    path.join(options.outputDirectory, "backfill-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  return report;
}
