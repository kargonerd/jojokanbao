import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
  gunzipJoxJson,
  transformJoxBytes,
  type JojoCatalog,
  type JojoDatasetIndex,
} from "@jojo/content";

async function readJox<T>(root: string, objectKey: string): Promise<T | undefined> {
  try {
    return await gunzipJoxJson<T>(
      new Uint8Array(await readFile(path.join(root, ...objectKey.split("/")))),
      objectKey,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeJox(root: string, objectKey: string, value: unknown): Promise<void> {
  const compressed = gzipSync(Buffer.from(`${JSON.stringify(value)}\n`, "utf8"), { level: 9 });
  const output = path.join(root, ...objectKey.split("/"));
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, transformJoxBytes(compressed, objectKey));
}

export async function mergeDeliveryMetadata(input: {
  localRoot: string;
  remoteRoot: string;
  outputRoot: string;
  updatedAt?: string;
}): Promise<{ datasets: number; indexes: number }> {
  const local = await readJox<JojoCatalog>(input.localRoot, "catalog.jox");
  if (!local) throw new Error("本次构建缺少 delivery/catalog.jox");
  const remote = await readJox<JojoCatalog>(input.remoteRoot, "catalog.jox");
  const entries = new Map((remote?.datasets ?? []).map((entry) => [entry.datasetId, entry]));
  for (const entry of local.datasets) entries.set(entry.datasetId, entry);
  const catalog: JojoCatalog = {
    formatVersion: "jojo-catalog/1",
    revision: Math.max(local.revision, remote?.revision ?? 0) + (remote ? 1 : 0),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    datasets: [...entries.values()].sort((left, right) => left.title.localeCompare(right.title, "zh-CN")),
  };

  let indexes = 0;
  for (const entry of local.datasets) {
    const objectKey = entry.indexObject;
    const localIndex = await readJox<JojoDatasetIndex>(input.localRoot, objectKey);
    if (!localIndex) throw new Error(`本次构建缺少 ${objectKey}`);
    const remoteIndex = await readJox<JojoDatasetIndex>(input.remoteRoot, objectKey);
    const items = new Map((remoteIndex?.items ?? []).map((item) => [item.itemId, item]));
    for (const item of localIndex.items) items.set(item.itemId, item);
    const merged: JojoDatasetIndex = {
      ...localIndex,
      revision: Math.max(localIndex.revision, remoteIndex?.revision ?? 0) + (remoteIndex ? 1 : 0),
      type: items.size > 1 && localIndex.type === "book" ? "book-series" : localIndex.type,
      items: [...items.values()].sort((left, right) => left.order - right.order || left.title.localeCompare(right.title, "zh-CN")),
    };
    await writeJox(input.outputRoot, objectKey, merged);
    indexes += 1;
  }
  await writeJox(input.outputRoot, "catalog.jox", catalog);
  return { datasets: catalog.datasets.length, indexes };
}
