import { gzipSync } from "node:zlib";
import { CONTENT_SEARCH_API, transformJoxBytes } from "@jojo/content";
import { describe, expect, it, vi } from "vitest";
import { createRagTools, type RagScope } from "../src/rag-tools";
import { toolSourceReferences } from "../src/runtime";

function jox(value: unknown, key: string): Uint8Array {
  return transformJoxBytes(gzipSync(JSON.stringify(value)), key);
}

function seriesFixture(scope: RagScope) {
  const indexObject = "content/books/series/index.jox";
  const itemIds = ["series:one", "series:two", "series:draft"];
  const manifestObjects = itemIds.map((id) => `content/books/series/items/${id.split(":")[1]}/manifest.jox`);
  const fragmentObjects = manifestObjects.map((object) => object.replace("manifest.jox", "chapter.jox"));
  const objects = new Map<string, Uint8Array>();
  const add = (object: string, value: unknown) => objects.set(`https://cdn.test/${object}`, jox(value, object));
  add("catalog.jox", {
    formatVersion: "jojo-catalog/1", revision: 1, updatedAt: "2026-09-08T00:00:00.000Z",
    datasets: [{
      datasetId: "series", type: "book-series", title: "分卷测试", language: "zh-CN",
      itemCount: 3, indexObject, aiEnabled: true, publicationStatus: "published",
    }],
  });
  add(indexObject, {
    formatVersion: "jojo-delivery-index/1", revision: 1, datasetId: "series",
    type: "book-series", title: "分卷测试", language: "zh-CN", aiEnabled: true,
    items: itemIds.map((itemId, index) => ({
      itemId, itemKey: itemId.split(":")[1], type: "book", order: index + 1,
      title: `第 ${index + 1} 卷`, manifestObject: manifestObjects[index]!.slice("content/books/series/".length),
      publicationStatus: index === 2 ? "draft" : "published",
    })),
  });
  itemIds.forEach((itemId, index) => {
    add(manifestObjects[index]!, {
      formatVersion: "jojo-item-manifest/1", revision: 1, itemId, datasetId: "series",
      type: "book", title: `第 ${index + 1} 卷`, language: "zh-CN", metadata: {},
      content: {
        schema: "jojo-content/book/1",
        chapters: [{ id: "chapter:1", order: 1, title: "正文", characterCount: 5, object: "chapter.jox", size: 100, sha256: "chapter" }],
      },
      contentStats: { chapterCount: 1, characterCount: 5 }, assets: [], exports: [],
      search: { format: "text", profile: "jojo-book-search/1", object: "search.jox", size: 100, sha256: "search" },
    });
    add(manifestObjects[index]!.replace("manifest.jox", "search.jox"), {
      formatVersion: "jojo-book-search/1", itemId,
      blocks: [{ targetId: "chapter:1", order: 1, text: `苹果 第 ${index + 1} 卷` }],
    });
    add(fragmentObjects[index]!, {
      formatVersion: "jojo-fragment/1", itemId, fragmentId: "chapter:1", type: "chapter", order: 1, title: "正文",
      body: { format: "text", value: `苹果 第 ${index + 1} 卷` }, assetRefs: [], annotations: [],
    });
  });
  const fetchFn = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    if (String(input) === CONTENT_SEARCH_API) return Response.json({ data: { total: 1, results: [{
      type: "newspaper", datasetId: "rmrb", itemId: "rmrb:1981-07-17", documentId: "article-1",
      title: "苹果报道", content: "苹果报刊原文", date: "1981-07-17", metadata: { page: 2 },
    }] } });
    const bytes = objects.get(String(input));
    return bytes ? new Response(bytes.slice().buffer) : new Response(null, { status: 404 });
  });
  const tools = createRagTools({ contentCdnBase: "https://cdn.test/", scope, fetchFn: fetchFn as typeof fetch });
  return { tool: (name: string) => tools.find((tool) => tool.name === name)!, fetchFn, itemIds, manifestObjects, fragmentObjects };
}

describe("RAG content tools", () => {
  it.each([{}, { contentType: "all" as const, datasetIds: ["rmrb", "series"] }])(
    "searches book indexes and periodical ES with separate citations in a combined scope: %j", async (scope) => {
      const { tool, fetchFn, fragmentObjects } = seriesFixture(scope);
      await tool("list_library_books").execute("list", {}, undefined);
      const books = await tool("search_content").execute("books", { query: "苹果", datasetIds: ["series"] }, undefined);
      expect(books.details).toMatchObject({ total: 2, searchedItemCount: 2 });
      const book = await tool("read_fragment").execute("book", { fragmentObject: fragmentObjects[0] }, undefined);
      expect(toolSourceReferences(book)[0]).toMatchObject({ datasetId: "series", itemId: "series:one", targetId: "chapter:1" });
      const papers = await tool("search_periodicals").execute("papers", { query: "苹果" }, undefined);
      expect(papers.details).toMatchObject({ total: 1 });
      const paper = await tool("read_periodical_article").execute("paper", { targetId: "article-1" }, undefined);
      expect(toolSourceReferences(paper)[0]).toMatchObject({ type: "newspaper", datasetId: "rmrb", date: "1981-07-17", page: 2 });
      expect(toolSourceReferences(book)[0]?.citationId).not.toBe(toolSourceReferences(paper)[0]?.citationId);
      const esCall = fetchFn.mock.calls.find(([url]) => String(url) === CONTENT_SEARCH_API)!;
      expect(JSON.parse(String(esCall[1]?.body))).toMatchObject({ datasetIds: ["rmrb"], types: ["newspaper"] });
    },
  );

  it("does not widen a combined selection into an unselected source type", async () => {
    const books = seriesFixture({ contentType: "all", datasetIds: ["series"] });
    expect(books.tool("search_periodicals")).toBeUndefined();
    expect((await books.tool("search_content").execute("books", { query: "苹果" }, undefined)).details).toMatchObject({ total: 2 });
    const papers = seriesFixture({ contentType: "all", datasetIds: ["rmrb"] });
    expect(papers.tool("search_content")).toBeUndefined();
    expect((await papers.tool("search_periodicals").execute("papers", { query: "苹果" }, undefined)).details).toMatchObject({ total: 1 });
  });

  it.each([
    { itemIds: ["series:one"] },
    { manifestObjects: ["content/books/series/items/one/manifest.jox"] },
    { itemIds: ["series:one"], manifestObjects: ["content/books/series/items/one/manifest.jox"] },
  ])("lists and searches only the selected volume for scope %j", async (selection) => {
    const { tool, fetchFn, itemIds, manifestObjects, fragmentObjects } = seriesFixture({
      mode: "selected", datasetIds: ["series"], ...selection,
    });
    const listed = await tool("list_book_items").execute("list", {}, undefined);
    expect(listed.details).toMatchObject({ datasets: [{ items: [{ itemId: itemIds[0], manifestObject: manifestObjects[0] }] }] });
    expect((listed.details as { datasets: { items: unknown[] }[] }).datasets[0]!.items).toHaveLength(1);

    const searched = await tool("search_content").execute("search", {
      query: "苹果", itemIds,
    }, undefined);
    expect(searched.details).toMatchObject({
      total: 1, searchedItemCount: 1,
      hits: [{ itemId: itemIds[0], manifestObject: manifestObjects[0], fragmentObject: fragmentObjects[0] }],
    });
    const outsideSearch = await tool("search_content").execute("search-outside", {
      query: "苹果", itemIds: [itemIds[1]],
    }, undefined);
    expect(outsideSearch.details).toMatchObject({ total: 0, searchedItemCount: 0, hits: [] });
    expect(fetchFn.mock.calls.some(([url]) => String(url).includes("/two/") || String(url).includes("/draft/"))).toBe(false);

    const read = await tool("read_fragment").execute("read", { fragmentObject: fragmentObjects[0] }, undefined);
    expect(read.details).toMatchObject({ itemId: itemIds[0], text: "苹果 第 1 卷" });
    for (const name of ["inspect_item", "list_item_toc"]) {
      await expect(tool(name).execute(name, { manifestObject: manifestObjects[1] }, undefined)).rejects.toThrow("不在用户选择范围内");
    }
    await expect(tool("read_fragment").execute("read-outside", {
      fragmentObject: fragmentObjects[1],
    }, undefined)).rejects.toThrow("不在用户选择范围内");
    if (selection.manifestObjects) {
      await expect(tool("search_selected_item").execute("selected-outside", {
        query: "苹果", manifestObject: manifestObjects[1],
      }, undefined)).rejects.toThrow("不在用户选择范围内");
      expect(fetchFn.mock.calls.some(([url]) => String(url).includes("/two/"))).toBe(false);
    }
  });

  it("keeps all published volumes available when the whole dataset is selected", async () => {
    const { tool } = seriesFixture({ mode: "selected", datasetIds: ["series"] });
    const listed = await tool("list_book_items").execute("list", {}, undefined);
    expect((listed.details as { datasets: { items: { itemId: string }[] }[] }).datasets[0]!.items.map((item) => item.itemId))
      .toEqual(["series:one", "series:two"]);
    const searched = await tool("search_content").execute("search", { query: "苹果" }, undefined);
    expect(searched.details).toMatchObject({ total: 2, searchedItemCount: 2 });
  });

  it("enforces the selected scope and scans a full Item outside model context", async () => {
    const catalogObject = "catalog.jox";
    const datasetIndexObject = "content/books/book-a/index.jox";
    const manifestObject = "content/books/book-a/items/full-book/manifest.jox";
    const noSearchManifestObject = "content/books/book-a/items/full-book/manifest-no-search.jox";
    const searchObject = "content/books/book-a/items/full-book/search.jox";
    const chapterOneObject = "content/books/book-a/items/full-book/chapters/one.jox";
    const chapterTwoObject = "content/books/book-a/items/full-book/chapters/two.jox";
    const manifest = {
      formatVersion: "jojo-item-manifest/1",
      revision: 1,
      itemId: "book-a:full-book",
      datasetId: "book-a",
      type: "book",
      title: "测试书",
      language: "zh-CN",
      metadata: {},
      content: {
        schema: "jojo-content/book/1",
        toc: [{
          id: "toc:root", order: 1, title: "上编", children: [
            { id: "toc:1", order: 2, title: "第一章", targetId: "chapter:1" },
            { id: "toc:2", order: 3, title: "第二章", targetId: "chapter:2", anchorId: "section:two" },
          ],
        }],
        chapters: [
          { id: "chapter:1", order: 1, title: "第一章", characterCount: 20, object: "chapters/one.jox", size: 200, sha256: "a" },
          { id: "chapter:2", order: 2, title: "第二章", characterCount: 20, object: "chapters/two.jox", size: 200, sha256: "b" },
        ],
      },
      contentStats: { chapterCount: 2, characterCount: 40 },
      assets: [],
      exports: [],
      search: {
        format: "text",
        profile: "jojo-book-search/1",
        object: "search.jox",
        size: 100,
        sha256: "search",
      },
    };
    const fragment = (id: string, title: string, body: string) => ({
      formatVersion: "jojo-fragment/1",
      itemId: "book-a:full-book",
      fragmentId: id,
      type: "chapter",
      order: Number(id.at(-1)),
      title,
      body: { format: "html", profile: "jojo-semantic-html/1", value: `<p>${body}</p>` },
      assetRefs: [],
      annotations: [],
    });
    const objects = new Map([
      [`https://cdn.test/${catalogObject}`, jox({
        formatVersion: "jojo-catalog/1",
        revision: 1,
        updatedAt: "2026-08-25T00:00:00.000Z",
        datasets: [{
          datasetId: "book-a",
          type: "book",
          title: "测试书",
          language: "zh-CN",
          itemCount: 1,
          indexObject: datasetIndexObject,
          aiEnabled: true,
          publicationStatus: "published",
        }],
      }, catalogObject)],
      [`https://cdn.test/${datasetIndexObject}`, jox({
        formatVersion: "jojo-delivery-index/1",
        revision: 1,
        datasetId: "book-a",
        type: "book",
        title: "测试书",
        language: "zh-CN",
        aiEnabled: true,
        items: [{
          itemId: "book-a:full-book",
          itemKey: "full-book",
          type: "book",
          order: 1,
          title: "测试书",
          manifestObject: "items/full-book/manifest.jox",
          publicationStatus: "published",
        }],
      }, datasetIndexObject)],
      [`https://cdn.test/${manifestObject}`, jox(manifest, manifestObject)],
      [`https://cdn.test/${noSearchManifestObject}`, jox({
        ...manifest,
        search: undefined,
      }, noSearchManifestObject)],
      [`https://cdn.test/${searchObject}`, jox({
        formatVersion: "jojo-book-search/1",
        itemId: "book-a:full-book",
        blocks: [
          { targetId: "chapter:1", order: 1, text: "第一章 苹果和梨" },
          { targetId: "chapter:2", order: 2, text: "第二章 苹果苹果" },
        ],
      }, searchObject)],
      [`https://cdn.test/${chapterOneObject}`, jox(fragment("chapter:1", "第一章", "苹果和梨"), chapterOneObject)],
      [`https://cdn.test/${chapterTwoObject}`, jox(fragment("chapter:2", "第二章", "苹果苹果"), chapterTwoObject)],
    ]);
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const bytes = objects.get(String(input));
      return bytes ? new Response(bytes.slice().buffer) : new Response(null, { status: 404 });
    });
    const tools = createRagTools({
      contentCdnBase: "https://cdn.test/",
      scope: {
        mode: "selected",
        datasetIds: ["book-a"],
        itemIds: ["book-a:full-book"],
        manifestObjects: [manifestObject],
      },
      fetchFn: fetchFn as typeof fetch,
    });
    const search = tools.find((tool) => tool.name === "search_content")!;
    const searched = await search.execute("search", {
      query: "苹果",
      datasetIds: ["book-a"],
    }, undefined);
    expect(searched.details).toMatchObject({
      strategy: "candidate-static-index-memory",
      total: 2,
      searchedItemCount: 1,
      hits: [{
        datasetId: "book-a",
        datasetTitle: "测试书",
        itemId: "book-a:full-book",
        manifestObject,
      }, {
        datasetId: "book-a",
        datasetTitle: "测试书",
        itemId: "book-a:full-book",
        manifestObject,
      }],
    });
    const inspect = tools.find((tool) => tool.name === "inspect_item")!;
    const inspection = await inspect.execute("inspect", {}, undefined);
    expect(inspection.details).toMatchObject({
      itemId: "book-a:full-book",
      chapterCount: 2,
      characterCount: 40,
      estimatedProcessingBytes: 400,
      withinFullScanBudget: true,
      tocEntryCount: 3,
      tocPreview: [
        { depth: 0, title: "上编" },
        { depth: 1, title: "第一章", fragmentObject: chapterOneObject },
        { depth: 1, title: "第二章", fragmentObject: chapterTwoObject },
      ],
    });
    const selectedOnlyTools = createRagTools({
      contentCdnBase: "https://cdn.test/",
      scope: {
        datasetIds: ["book-a"],
        itemIds: ["book-a:full-book"],
        manifestObjects: [manifestObject],
      },
      fetchFn: fetchFn as typeof fetch,
    });
    expect(selectedOnlyTools.find((tool) => tool.name === "search_content")).toBeDefined();
    const selectedInspection = await selectedOnlyTools
      .find((tool) => tool.name === "inspect_item")!
      .execute("inspect-selected", {}, undefined);
    expect(selectedInspection.details).toMatchObject({ title: "测试书" });
    const localSearch = selectedOnlyTools.find((tool) => tool.name === "search_selected_item")!;
    const localResult = await localSearch.execute("local-search", {
      query: "苹果和梨",
    }, undefined);
    expect(localResult.details).toMatchObject({
      available: true,
      strategy: "static-book-index-memory",
      total: 1,
      hits: [{
        datasetId: "book-a",
        itemId: "book-a:full-book",
        targetId: "chapter:1",
        targetTitle: "第一章",
        manifestObject,
        fragmentObject: chapterOneObject,
      }],
    });
    const focusedTools = createRagTools({
      contentCdnBase: "https://cdn.test/",
      scope: {
        mode: "selected",
        datasetIds: ["book-a"],
        itemIds: ["book-a:full-book"],
        manifestObjects: [manifestObject],
      },
      focus: {
        chapterId: "chapter:1",
        chapterTitle: "第一章",
        quote: "苹果和梨",
        prefix: "第一章",
        suffix: "",
      },
      fetchFn: fetchFn as typeof fetch,
    });
    const focused = await focusedTools
      .find((tool) => tool.name === "read_focus_context")!
      .execute("focus", {}, undefined);
    expect(focused.details).toMatchObject({
      available: true,
      strategy: "reader-focus-context",
      datasetId: "book-a",
      itemId: "book-a:full-book",
      targetId: "chapter:1",
      title: "第一章",
      selectedQuote: "苹果和梨",
      text: "苹果和梨",
      citationId: expect.stringMatching(/^J/),
      source: { fragmentObject: chapterOneObject },
    });
    const noSearchTools = createRagTools({
      contentCdnBase: "https://cdn.test/",
      scope: {
        mode: "selected",
        datasetIds: ["book-a"],
        itemIds: ["book-a:full-book"],
        manifestObjects: [noSearchManifestObject],
      },
      fetchFn: fetchFn as typeof fetch,
    });
    const unavailable = await noSearchTools
      .find((tool) => tool.name === "search_selected_item")!
      .execute("local-search-unavailable", { query: "苹果" }, undefined);
    expect(unavailable.details).toMatchObject({
      available: false,
      total: 0,
      advice: expect.stringContaining("list_item_toc"),
    });
    const toc = tools.find((tool) => tool.name === "list_item_toc")!;
    const listed = await toc.execute("toc", { manifestObject, offset: 1, limit: 1 }, undefined);
    expect(listed.details).toMatchObject({
      total: 3,
      offset: 1,
      entries: [{ depth: 1, title: "第一章", fragmentObject: chapterOneObject }],
      hasMore: true,
      nextOffset: 2,
    });
    const scan = tools.find((tool) => tool.name === "scan_full_item")!;
    const output = await scan.execute("scan", {
      manifestObject,
      intent: "统计全书",
      terms: ["苹果"],
      maxEvidenceChapters: 2,
    }, undefined);
    expect(output.details).toMatchObject({
      scanned: true,
      scannedChapterCount: 2,
      totalOccurrences: { "苹果": 3 },
    });
    const filtered = await scan.execute("scan-filtered", {
      manifestObject,
      intent: "只返回真正命中的章节",
      terms: ["梨"],
      maxEvidenceChapters: 2,
    }, undefined);
    expect(filtered.details).toMatchObject({
      totalOccurrences: { "梨": 1 },
      evidence: [{ chapterId: "chapter:1", occurrences: 1 }],
    });
    expect((filtered.details as { evidence: unknown[] }).evidence).toHaveLength(1);

    const limitedTools = createRagTools({
      contentCdnBase: "https://cdn.test/",
      scope: { datasetIds: ["book-a"], itemIds: ["book-a:full-book"] },
      fetchFn: fetchFn as typeof fetch,
      fullItemByteBudget: 300,
    });
    const limitedScan = limitedTools.find((tool) => tool.name === "scan_full_item")!;
    const uninspected = await limitedScan.execute("scan-before-inspect", {
      manifestObject,
      intent: "验证必须先检查规模",
      terms: ["苹果"],
    }, undefined);
    expect(uninspected.details).toMatchObject({
      scanned: false,
      reason: "item must be inspected before full scan",
    });
    const limitedInspect = limitedTools.find((tool) => tool.name === "inspect_item")!;
    const limitedInspection = await limitedInspect.execute("inspect-limited", { manifestObject }, undefined);
    expect(limitedInspection.details).toMatchObject({
      estimatedProcessingBytes: 400,
      fullScanByteBudget: 300,
      withinFullScanBudget: false,
    });
    const refused = await limitedScan.execute("scan-limited", {
      manifestObject,
      intent: "验证预算拒绝",
      terms: ["苹果"],
    }, undefined);
    expect(refused.details).toMatchObject({
      scanned: false,
      reason: "item exceeds full-scan byte budget",
      estimatedBytes: 400,
      byteBudget: 300,
    });
    expect(fetchFn).toHaveBeenCalledTimes(14);
  });
});
