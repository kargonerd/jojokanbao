import {
  JoxClient,
  resolveJoxObject,
  asJojoCatalog,
  asJojoDatasetIndex,
  asJojoItemManifest,
  type JojoCatalog,
  type JojoCatalogEntry,
  type JojoDatasetIndex,
  type JojoDatasetItemSummary,
  type JojoFragment,
  type JojoItemManifest,
} from "@jojo/content";

const CONTENT_CDN = import.meta.env.VITE_CONTENT_CDN_BASE || "https://blacknews.jojokanbao.cn/";
const client = new JoxClient(CONTENT_CDN);
let catalogPromise: Promise<JojoCatalog> | undefined;

export interface LoadedDataset {
  entry: JojoCatalogEntry;
  index: JojoDatasetIndex;
}

export interface LoadedItem extends LoadedDataset {
  item: JojoDatasetItemSummary;
  manifest: JojoItemManifest;
  manifestObject: string;
}

export function loadCatalog(): Promise<JojoCatalog> {
  catalogPromise ??= client.fetchJson<JojoCatalog>("catalog.jox").then(asJojoCatalog);
  return catalogPromise;
}

export async function loadDataset(datasetId: string): Promise<LoadedDataset> {
  const catalog = await loadCatalog();
  const entry = catalog.datasets.find((candidate) => candidate.datasetId === datasetId);
  if (!entry) throw new Error("Dataset 不存在");
  const index = asJojoDatasetIndex(await client.fetchJson<JojoDatasetIndex>(entry.indexObject));
  if (index.datasetId !== datasetId) throw new Error("Dataset Index 格式无效");
  return { entry, index };
}

export async function loadItem(datasetId: string, itemKey: string): Promise<LoadedItem> {
  const dataset = await loadDataset(datasetId);
  const item = dataset.index.items.find((candidate) => candidate.itemKey === itemKey || candidate.itemId === itemKey);
  if (!item) throw new Error("Item 不存在");
  const manifestObject = resolveJoxObject(dataset.entry.indexObject, item.manifestObject);
  const manifest = asJojoItemManifest(await client.fetchJson<JojoItemManifest>(manifestObject));
  if (manifest.itemId !== item.itemId) throw new Error("Item Manifest 格式无效");
  return { ...dataset, item, manifest, manifestObject };
}

export async function loadFragment(loaded: LoadedItem, chapterId: string): Promise<JojoFragment> {
  const chapter = loaded.manifest.content.chapters?.find((candidate) => candidate.id === chapterId);
  if (!chapter) throw new Error("章节不存在");
  return client.fetchJson<JojoFragment>(resolveJoxObject(loaded.manifestObject, chapter.object));
}

export async function loadAssetUrl(loaded: LoadedItem, assetId: string): Promise<string> {
  const asset = loaded.manifest.assets.find((candidate) => candidate.id === assetId);
  if (!asset) throw new Error(`资源不存在：${assetId}`);
  const bytes = await client.fetchDecodedBytes(resolveJoxObject(loaded.manifestObject, asset.object));
  return URL.createObjectURL(new Blob([bytes.slice().buffer], { type: asset.mediaType }));
}

export async function downloadExport(loaded: LoadedItem, exportId: string): Promise<void> {
  const descriptor = loaded.manifest.exports.find((candidate) => candidate.id === exportId);
  if (!descriptor) throw new Error("导出文件不存在");
  const bytes = await client.fetchDecodedBytes(resolveJoxObject(loaded.manifestObject, descriptor.object));
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: descriptor.mediaType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = descriptor.fileName;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
