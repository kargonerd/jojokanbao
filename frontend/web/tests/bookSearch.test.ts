import { describe, expect, it, vi } from "vitest";
import type { JojoBookSearchIndex, JojoItemManifest } from "@jojo/content";
import { searchLoadedBook, type LoadedItem } from "../src/rag/content";

function loadedBook(search?: JojoItemManifest["search"]): LoadedItem {
  const manifest: JojoItemManifest = {
    formatVersion: "jojo-item-manifest/1",
    revision: 1,
    itemId: "example:full-book",
    datasetId: "example",
    type: "book",
    title: "示例书",
    language: "zh-CN",
    metadata: {},
    content: {
      schema: "jojo-content/book/1",
      chapters: [{ id: "chapter:1", order: 1, title: "第一章", characterCount: 12, object: "chapters/one.jox", size: 1, sha256: "chapter" }],
    },
    contentStats: { chapterCount: 1, characterCount: 12 },
    ...(search ? { search } : {}),
    assets: [],
    exports: [],
  };
  return {
    entry: { datasetId: "example", type: "book", title: "示例书", language: "zh-CN", indexObject: "content/books/example/index.jox" },
    index: { formatVersion: "jojo-delivery-index/1", revision: 1, datasetId: "example", type: "book", title: "示例书", language: "zh-CN", items: [] },
    client: { fetchJson: vi.fn() } as unknown as LoadedItem["client"],
    itemClients: new Map(),
    item: { itemId: manifest.itemId, itemKey: "full-book", type: "book", order: 1, title: manifest.title, manifestObject: "items/full-book/manifest.jox" },
    manifest,
    manifestObject: "content/books/example/items/full-book/manifest.jox",
  };
}

describe("static book search", () => {
  it("downloads one text.jox and searches its plain-text blocks", async () => {
    const loaded = loadedBook({ format: "text", profile: "jojo-book-search/1", object: "search/text.jox", size: 10, sha256: "search" });
    const index: JojoBookSearchIndex = {
      formatVersion: "jojo-book-search/1",
      itemId: loaded.manifest.itemId,
      blocks: [
        { targetId: "chapter:1", order: 1, text: "没有命中的段落" },
        { targetId: "chapter:1", order: 2, text: "这是一段需要搜索的正文。" },
      ],
    };
    vi.mocked(loaded.client.fetchJson).mockResolvedValue(index);

    const results = await searchLoadedBook(loaded, "搜索");

    expect(loaded.client.fetchJson).toHaveBeenCalledOnce();
    expect(loaded.client.fetchJson).toHaveBeenCalledWith("content/books/example/items/full-book/search/text.jox");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ targetId: "chapter:1", targetTitle: "第一章" });
    expect(results[0]!.highlights?.[0]).toContain("<mark>搜索</mark>");
  });
});
