import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import JSZip from "jszip";
import {
  asJojoCatalog,
  asJojoDatasetIndex,
  asJojoFragment,
  asJojoItemManifest,
  resolveJoxObject,
  transformJoxBytes,
  type JojoCanonicalItem,
  type JojoItemManifest,
  type JojoTocNode,
} from "@jojo/content";
import type { PipelineReport } from "./models";

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function protectedBytes(root: string, key: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path.join(root, "delivery", ...key.split("/"))));
}

async function clearBytes(root: string, key: string): Promise<Uint8Array> {
  return transformJoxBytes(await protectedBytes(root, key), key);
}

async function jsonObject<T>(root: string, key: string): Promise<T> {
  return JSON.parse(gunzipSync(await clearBytes(root, key)).toString("utf8")) as T;
}

function tocTargets(nodes: JojoTocNode[]): string[] {
  return nodes.flatMap((node) => [
    ...(node.targetId ? [node.targetId] : []),
    ...tocTargets(node.children ?? []),
  ]);
}

export interface ValidationSummary {
  datasets: number;
  items: number;
  fragments: number;
  assets: number;
  exports: number;
  searchDocuments: number;
  errors: string[];
}

export async function validatePipelineOutput(rootDirectory: string): Promise<ValidationSummary> {
  const root = path.resolve(rootDirectory);
  const errors: string[] = [];
  const report = JSON.parse(await readFile(path.join(root, "report.json"), "utf8")) as PipelineReport;
  const catalog = asJojoCatalog(await jsonObject(root, "catalog.jox"));
  const knownObjects = new Set(["catalog.jox"]);
  let items = 0;
  let fragments = 0;
  let assets = 0;
  let exports = 0;

  for (const entry of catalog.datasets) {
    knownObjects.add(entry.indexObject);
    const index = asJojoDatasetIndex(await jsonObject(root, entry.indexObject));
    if (index.datasetId !== entry.datasetId) errors.push(`${entry.indexObject}: datasetId 不一致`);
    for (const item of index.items) {
      items += 1;
      const manifestObject = resolveJoxObject(entry.indexObject, item.manifestObject);
      knownObjects.add(manifestObject);
      const manifest = asJojoItemManifest(await jsonObject<JojoItemManifest>(root, manifestObject));
      if (manifest.itemId !== item.itemId) errors.push(`${manifestObject}: itemId 不一致`);
      for (const chapter of manifest.content.chapters ?? []) {
        fragments += 1;
        const object = resolveJoxObject(manifestObject, chapter.object);
        knownObjects.add(object);
        const compressed = await clearBytes(root, object);
        const clear = new Uint8Array(gunzipSync(compressed));
        if (clear.length !== chapter.size) errors.push(`${object}: size 不一致`);
        if (digest(clear) !== chapter.sha256) errors.push(`${object}: SHA-256 不一致`);
        const fragment = asJojoFragment(JSON.parse(Buffer.from(clear).toString("utf8")));
        if (fragment.fragmentId !== chapter.id || fragment.itemId !== manifest.itemId) errors.push(`${object}: Fragment 身份不一致`);
      }
      for (const asset of manifest.assets) {
        assets += 1;
        const object = resolveJoxObject(manifestObject, asset.object);
        knownObjects.add(object);
        const clear = await clearBytes(root, object);
        if (clear.length !== asset.size) errors.push(`${object}: Asset size 不一致`);
        if (digest(clear) !== asset.sha256) errors.push(`${object}: Asset SHA-256 不一致`);
      }
      for (const exported of manifest.exports) {
        exports += 1;
        const object = resolveJoxObject(manifestObject, exported.object);
        knownObjects.add(object);
        const clear = await clearBytes(root, object);
        if (clear.length !== exported.size) errors.push(`${object}: Export size 不一致`);
        if (digest(clear) !== exported.sha256) errors.push(`${object}: Export SHA-256 不一致`);
        if (exported.format === "epub") {
          const zip = await JSZip.loadAsync(clear);
          const mimetype = await zip.file("mimetype")?.async("string");
          if (mimetype !== "application/epub+zip") errors.push(`${object}: EPUB mimetype 无效`);
        }
      }
      const summary = report.itemsBuilt.find((candidate) => candidate.itemId === item.itemId);
      if (!summary) {
        errors.push(`${item.itemId}: report 中缺少 Item`);
        continue;
      }
      const canonical = JSON.parse(gunzipSync(await readFile(path.join(root, ...summary.canonicalObject.split("/")))).toString("utf8")) as JojoCanonicalItem;
      const chapterIds = new Set(canonical.content.chapters.map((chapter) => chapter.id));
      for (const target of tocTargets(canonical.content.toc)) {
        if (!chapterIds.has(target)) errors.push(`${summary.canonicalObject}: TOC target ${target} 不存在`);
      }
    }
  }

  const searchText = gunzipSync(await readFile(path.join(root, "search", "documents.jsonl.gz"))).toString("utf8");
  const searchDocuments = searchText.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { manifestObject: string; fragmentObject: string });
  for (const document of searchDocuments) {
    if (!knownObjects.has(document.manifestObject)) errors.push(`${document.manifestObject}: 搜索 Manifest 不存在`);
    if (!knownObjects.has(document.fragmentObject)) errors.push(`${document.fragmentObject}: 搜索 Fragment 不存在`);
  }
  if (catalog.datasets.length !== report.datasets) errors.push("Dataset 总数与 report 不一致");
  if (items !== report.items) errors.push("Item 总数与 report 不一致");
  if (fragments !== report.chapters) errors.push("章节总数与 report 不一致");
  if (searchDocuments.length !== report.searchDocuments) errors.push("搜索文档总数与 report 不一致");
  return { datasets: catalog.datasets.length, items, fragments, assets, exports, searchDocuments: searchDocuments.length, errors };
}
