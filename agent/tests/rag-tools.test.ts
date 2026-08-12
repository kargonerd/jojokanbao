import { gzipSync } from "node:zlib";
import { transformJoxBytes } from "@jojo/content";
import { describe, expect, it, vi } from "vitest";
import { createRagTools } from "../src/rag-tools";

function jox(value: unknown, key: string): Uint8Array {
  return transformJoxBytes(gzipSync(JSON.stringify(value)), key);
}

describe("RAG content tools", () => {
  it("enforces the selected scope and scans a full Item outside model context", async () => {
    const manifestObject = "content/books/book-a/items/full-book/manifest.jox";
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
      [`https://cdn.test/${manifestObject}`, jox(manifest, manifestObject)],
      [`https://cdn.test/${chapterOneObject}`, jox(fragment("chapter:1", "第一章", "苹果和梨"), chapterOneObject)],
      [`https://cdn.test/${chapterTwoObject}`, jox(fragment("chapter:2", "第二章", "苹果苹果"), chapterTwoObject)],
    ]);
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://search.test/content/search") {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({ datasetIds: ["book-a"], itemIds: ["book-a:full-book"] });
        return Response.json({ data: { total: 1, results: [{ itemId: "book-a:full-book" }] } });
      }
      const bytes = objects.get(String(input));
      return bytes ? new Response(bytes.slice().buffer) : new Response(null, { status: 404 });
    });
    const tools = createRagTools({
      searchUrl: "https://search.test/content/search",
      contentCdnBase: "https://cdn.test/",
      scope: { datasetIds: ["book-a"], itemIds: ["book-a:full-book"] },
      fetchFn: fetchFn as typeof fetch,
    });
    const search = tools.find((tool) => tool.name === "search_content")!;
    await search.execute("search", { query: "苹果", datasetIds: ["ignored"] }, undefined);
    const inspect = tools.find((tool) => tool.name === "inspect_item")!;
    const inspection = await inspect.execute("inspect", { manifestObject }, undefined);
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
      searchUrl: "https://search.test/content/search",
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
    expect(fetchFn).toHaveBeenCalledTimes(7);
  });
});
