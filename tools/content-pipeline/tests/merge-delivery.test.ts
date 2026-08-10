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
    expect(index.items.map((item) => item.itemId)).toEqual(["series:v1", "series:v2"]);
    expect(index.type).toBe("book-series");
  });
});
