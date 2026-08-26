import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
  gunzipJoxJson,
  transformJoxBytes,
  type JojoCatalog,
  type JojoDatasetIndex,
} from "@jojo/content";
import { describe, expect, it } from "vitest";
import { mergeDeliveryMetadata } from "../src/merge-delivery";

async function put(root: string, key: string, value: unknown) {
  const target = path.join(root, ...key.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, transformJoxBytes(gzipSync(JSON.stringify(value)), key));
}

describe("delivery metadata merge", () => {
  it("preserves remote datasets and merges volumes by stable itemId", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "jojo-merge-"));
    const remote = path.join(root, "remote");
    const local = path.join(root, "local");
    const output = path.join(root, "output");
    const entry = (id: string, title = id) => ({
      datasetId: id,
      type: "book" as const,
      title,
      language: "zh-CN",
      indexObject: `content/books/${id}/index.jox`,
      aiEnabled: true,
    });
    await put(remote, "catalog.jox", {
      formatVersion: "jojo-catalog/1",
      revision: 3,
      updatedAt: "old",
      datasets: [entry("existing"), entry("series"), entry("book-123456789abc", "series")],
    } satisfies JojoCatalog);
    await put(local, "catalog.jox", {
      formatVersion: "jojo-catalog/1",
      revision: 1,
      updatedAt: "new",
      datasets: [entry("series")],
    } satisfies JojoCatalog);
    const base = {
      formatVersion: "jojo-delivery-index/1" as const,
      revision: 1,
      datasetId: "series",
      type: "book" as const,
      title: "series",
      language: "zh-CN",
    };
    await put(remote, "content/books/series/index.jox", {
      ...base,
      items: [{ itemId: "series:v1", itemKey: "v1", type: "book-volume", order: 1, title: "一", manifestObject: "items/v1/manifest.jox" }],
    } satisfies JojoDatasetIndex);
    await put(local, "content/books/series/index.jox", {
      ...base,
      items: [{ itemId: "series:v2", itemKey: "v2", type: "book-volume", order: 2, title: "二", manifestObject: "items/v2/manifest.jox" }],
    } satisfies JojoDatasetIndex);
    await mergeDeliveryMetadata({ localRoot: local, remoteRoot: remote, outputRoot: output, updatedAt: "now" });
    const catalog = await gunzipJoxJson<JojoCatalog>(
      new Uint8Array(await readFile(path.join(output, "catalog.jox"))),
      "catalog.jox",
    );
    const index = await gunzipJoxJson<JojoDatasetIndex>(
      new Uint8Array(await readFile(path.join(output, "content/books/series/index.jox"))),
      "content/books/series/index.jox",
    );
    expect(catalog.datasets.map((item) => item.datasetId).sort()).toEqual(["existing", "series"]);
    expect(catalog.datasets.every((item) => item.aiEnabled === true)).toBe(true);
    expect(index.items?.map((item) => item.itemId)).toEqual(["series:v1", "series:v2"]);
    expect(index.type).toBe("book-series");
  });

  it("preserves capability fields without inferring them from Dataset type", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "jojo-merge-ai-capability-"));
    const remote = path.join(root, "remote");
    const local = path.join(root, "local");
    const output = path.join(root, "output");
    await put(remote, "catalog.jox", {
      formatVersion: "jojo-catalog/1",
      revision: 1,
      updatedAt: "old",
      datasets: [
        { datasetId: "book", type: "book", title: "书籍", language: "zh-CN", indexObject: "content/books/book/index.jox" },
        { datasetId: "times", type: "newspaper", title: "JOJO 时事", language: "mul", indexObject: "content/newspapers/times/index.jox" },
      ],
    } satisfies JojoCatalog);
    await put(local, "catalog.jox", {
      formatVersion: "jojo-catalog/1",
      revision: 1,
      updatedAt: "new",
      datasets: [],
    } satisfies JojoCatalog);

    await mergeDeliveryMetadata({ localRoot: local, remoteRoot: remote, outputRoot: output });
    const catalog = await gunzipJoxJson<JojoCatalog>(
      new Uint8Array(await readFile(path.join(output, "catalog.jox"))),
      "catalog.jox",
    );
    expect(catalog.datasets.find((item) => item.datasetId === "book")?.aiEnabled).toBeUndefined();
    expect(catalog.datasets.find((item) => item.datasetId === "times")?.aiEnabled).toBeUndefined();
  });

  it("removes explicitly superseded Dataset entries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "jojo-merge-superseded-"));
    const remote = path.join(root, "remote");
    const local = path.join(root, "local");
    const output = path.join(root, "output");
    const entry = (id: string, title: string) => ({
      datasetId: id,
      type: "book-series" as const,
      title,
      language: "zh-CN",
      indexObject: `content/books/${id}/index.jox`,
    });
    await put(remote, "catalog.jox", {
      formatVersion: "jojo-catalog/1", revision: 3, updatedAt: "old",
      datasets: [
        entry("mao-ze-dong-nian-pu-1893-1949-xiu-ding-ben", "毛泽东年谱:1893~1949(修订本)"),
        entry("mao-ze-dong-nian-pu-1949-1976", "毛泽东年谱:1949~1976"),
      ],
    } satisfies JojoCatalog);
    await put(local, "catalog.jox", {
      formatVersion: "jojo-catalog/1", revision: 1, updatedAt: "new",
      datasets: [entry("mao-ze-dong-nian-pu", "毛泽东年谱")],
    } satisfies JojoCatalog);
    await put(local, "content/books/mao-ze-dong-nian-pu/index.jox", {
      formatVersion: "jojo-delivery-index/1", revision: 1,
      datasetId: "mao-ze-dong-nian-pu", type: "book-series", title: "毛泽东年谱", language: "zh-CN", items: [],
    } satisfies JojoDatasetIndex);
    await mergeDeliveryMetadata({
      localRoot: local, remoteRoot: remote, outputRoot: output,
      removeDatasetIds: ["mao-ze-dong-nian-pu-1893-1949-xiu-ding-ben", "mao-ze-dong-nian-pu-1949-1976"],
    });
    const catalog = await gunzipJoxJson<JojoCatalog>(
      new Uint8Array(await readFile(path.join(output, "catalog.jox"))), "catalog.jox",
    );
    expect(catalog.datasets.map((item) => item.datasetId)).toEqual(["mao-ze-dong-nian-pu"]);
  });
});
