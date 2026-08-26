import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
  gunzipJoxJson,
  transformJoxBytes,
  type JojoBookSearchIndex,
  type JojoItemManifest,
} from "@jojo/content";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildBookSearchBackfill } from "../src/backfill-book-search";
import { validateBookSearchBackfill } from "../src/validate-book-search-backfill";

const temporaryDirectories: string[] = [];

function jox(value: unknown, objectKey: string): Uint8Array {
  return transformJoxBytes(gzipSync(`${JSON.stringify(value)}\n`), objectKey);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("book search backfill", () => {
  it("writes search first-class objects and a revised manifest without rebuilding content", async () => {
    const outputDirectory = await mkdtemp(path.join(tmpdir(), "jojo-book-search-backfill-"));
    temporaryDirectories.push(outputDirectory);
    const datasetId = "book-a";
    const itemId = "book-a:full-book";
    const indexObject = "content/books/book-a/index.jox";
    const manifestObject = "content/books/book-a/items/full-book/manifest.jox";
    const chapterObject = "content/books/book-a/items/full-book/chapters/one.jox";
    const objects = new Map<string, Uint8Array>([
      ["catalog.jox", jox({
        formatVersion: "jojo-catalog/1",
        revision: 1,
        updatedAt: "2026-08-25T00:00:00.000Z",
        datasets: [{
          datasetId,
          type: "book",
          title: "测试书",
          language: "zh-CN",
          indexObject,
          aiEnabled: true,
        }],
      }, "catalog.jox")],
      [indexObject, jox({
        formatVersion: "jojo-delivery-index/1",
        revision: 1,
        datasetId,
        type: "book",
        title: "测试书",
        language: "zh-CN",
        items: [{
          itemId,
          itemKey: "full-book",
          type: "book",
          order: 1,
          title: "测试书",
          manifestObject: "items/full-book/manifest.jox",
        }],
      }, indexObject)],
      [manifestObject, jox({
        formatVersion: "jojo-item-manifest/1",
        revision: 1,
        itemId,
        datasetId,
        type: "book",
        title: "测试书",
        language: "zh-CN",
        metadata: {},
        content: {
          schema: "jojo-content/book/1",
          toc: [{ id: "toc:one", order: 1, title: "第一章", targetId: "chapter:1" }],
          chapters: [{
            id: "chapter:1",
            order: 1,
            title: "第一章",
            characterCount: 8,
            object: "chapters/one.jox",
            size: 100,
            sha256: "chapter",
          }],
        },
        contentStats: { chapterCount: 1, characterCount: 8 },
        assets: [],
        exports: [],
      }, manifestObject)],
      [chapterObject, jox({
        formatVersion: "jojo-fragment/1",
        itemId,
        fragmentId: "chapter:1",
        type: "chapter",
        order: 1,
        title: "第一章",
        body: {
          format: "html",
          profile: "jojo-semantic-html/1",
          value: '<p id="paragraph:1">劳动创造价值</p>',
        },
        assetRefs: [],
        annotations: [],
      }, chapterObject)],
    ]);
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const objectKey = new URL(String(input)).pathname.replace(/^\//, "");
      const bytes = objects.get(objectKey);
      return bytes
        ? new Response(bytes.slice().buffer)
        : new Response(null, { status: 404 });
    });

    const report = await buildBookSearchBackfill({
      contentCdnBase: "https://cdn.test/",
      outputDirectory,
      fetchFn: fetchFn as typeof fetch,
    });

    expect(report).toMatchObject({
      selectedDatasetCount: 1,
      selectedItemCount: 1,
      skippedExistingCount: 0,
      backfilledItems: [{
        itemId,
        chapterCount: 1,
        blockCount: 1,
      }],
    });
    const searchObject = "content/books/book-a/items/full-book/search/text.jox";
    const search = await gunzipJoxJson<JojoBookSearchIndex>(
      new Uint8Array(await readFile(path.join(outputDirectory, ...searchObject.split("/")))),
      searchObject,
    );
    expect(search.blocks).toEqual([{
      targetId: "chapter:1",
      anchorId: "paragraph:1",
      order: 1,
      text: "劳动创造价值",
    }]);
    const manifest = await gunzipJoxJson<JojoItemManifest>(
      new Uint8Array(await readFile(path.join(outputDirectory, ...manifestObject.split("/")))),
      manifestObject,
    );
    expect(manifest).toMatchObject({
      revision: 2,
      content: { chapters: [{ object: "chapters/one.jox" }] },
      search: {
        profile: "jojo-book-search/1",
        object: "search/text.jox",
        size: expect.any(Number),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });

    await expect(validateBookSearchBackfill({
      outputDirectory,
      contentCdnBase: "https://cdn.test/",
      fetchFn: fetchFn as typeof fetch,
    })).resolves.toMatchObject({
      items: 1,
      chapters: 1,
      blocks: 1,
      anchoredBlocks: 1,
      fallbackBlocks: 0,
      errors: [],
    });
  });
});
