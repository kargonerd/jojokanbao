import { CONTENT_SEARCH_API } from "@jojo/content";
import { describe, expect, it, vi } from "vitest";
import { createRagTools, type RagScope } from "../src/rag-tools";
import { toolSourceReferences } from "../src/runtime";

const article = {
  type: "newspaper", datasetId: "rmrb", itemId: "rmrb:1999-06-25",
  documentId: "article-1", title: "关注黄河", content: "黄河原文。".repeat(2000),
  date: "1999-06-25", metadata: { page: 5 }, highlights: ["关注<mark>黄河</mark>"],
};

function fixture(scope: RagScope = { contentType: "periodical", datasetIds: ["rmrb"] }) {
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
    data: { total: 10, results: [article] },
  }));
  const tools = createRagTools({ contentCdnBase: "https://cdn.test", scope, fetchFn });
  return { tools, fetchFn, tool: (name: string) => tools.find((tool) => tool.name === name)! };
}

describe("periodical RAG tools", () => {
  it("uses only the ES service for periodicals and preserves citations through article reading", async () => {
    const { tools, tool, fetchFn } = fixture();
    expect(tools.map((tool) => tool.name)).toEqual(["search_periodicals", "read_periodical_article"]);
    const controller = new AbortController();
    const searched = await tool("search_periodicals").execute("search", {
      query: "黄河", startDate: "1999-01-01", endDate: "1999-12-31", sort: "timeAsc", page: 2,
    }, controller.signal);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(CONTENT_SEARCH_API);
    expect(JSON.parse(String(init?.body))).toEqual({
      query: "黄河", datasetIds: ["rmrb"], types: ["newspaper"], page: 2, size: 8,
      startDate: "1999-01-01", endDate: "1999-12-31", sort: "timeAsc",
    });
    expect(searched.details).toMatchObject({ total: 10, hits: [{ text: "关注黄河", page: 5 }] });
    const [citation] = toolSourceReferences(searched);
    expect(citation).toMatchObject({
      citationId: expect.any(String), type: "newspaper", datasetId: "rmrb", itemId: "rmrb:1999-06-25",
      targetId: "article-1", date: "1999-06-25", page: 5, title: "关注黄河",
    });
    const read = await tool("read_periodical_article").execute("read", { targetId: "article-1", limit: 10 }, undefined);
    expect(read.details).toMatchObject({ text: article.content.slice(0, 10), hasMore: true, nextOffset: 10 });
    expect(toolSourceReferences(read)[0]?.citationId).toBe(citation?.citationId);
    const rest = await tool("read_periodical_article").execute("rest", { targetId: "article-1", offset: 10 }, undefined);
    expect(rest.details).toMatchObject({ text: article.content.slice(10, 6010) });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    controller.abort();
    expect(init?.signal?.aborted).toBe(true);
  });

  it("does not expose ES tools to default or selected book scopes", () => {
    for (const scope of [{}, { contentType: "book" as const, datasetIds: ["book-a"] }]) {
      expect(fixture(scope).tools.map((tool) => tool.name)).not.toContain("search_periodicals");
    }
    expect(() => fixture({ contentType: "periodical", datasetIds: ["ckxx"] })).toThrow("仅支持人民日报");
    expect(() => fixture({ contentType: "periodical", manifestObjects: ["content/books/book-a/manifest.jox"] }))
      .toThrow("不支持书籍章节范围");
  });

  it("defaults to People's Daily and filters results outside the selected issue", async () => {
    const { tool, fetchFn } = fixture({ contentType: "periodical", itemIds: [article.itemId] });
    fetchFn.mockResolvedValueOnce(Response.json({ data: { total: 4, results: [
      article,
      { ...article, datasetId: "ckxx", itemId: "ckxx:1999-06-25", documentId: "other-paper" },
      { ...article, date: "1999-06-26", itemId: "rmrb:1999-06-26", documentId: "other-issue" },
      { ...article, type: "book", documentId: "book" },
    ] } }));
    const searched = await tool("search_periodicals").execute("search", { query: "黄河" }, undefined);
    expect((searched.details as { hits: unknown[] }).hits).toHaveLength(1);
    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toMatchObject({
      datasetIds: ["rmrb"], itemIds: [article.itemId],
    });
    await expect(tool("read_periodical_article").execute("read", { targetId: "other-issue" }, undefined))
      .rejects.toThrow("请先检索");
  });

  it.each([
    { query: " " }, { query: "黄河", startDate: "1999-01-01" },
    { query: "黄河", startDate: "1999-02-30", endDate: "1999-03-01" },
    { query: "黄河", startDate: "2000-01-01", endDate: "1999-01-01" },
    { query: "黄河", page: 0 }, { query: "黄河", size: 9 },
  ])("rejects invalid search parameters before fetching: %j", async (args) => {
    const { tool, fetchFn } = fixture();
    await expect(tool("search_periodicals").execute("search", args, undefined)).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("surfaces ES errors and malformed responses, and handles an empty search", async () => {
    const { tool, fetchFn } = fixture();
    fetchFn.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(tool("search_periodicals").execute("search", { query: "黄河" }, undefined)).rejects.toThrow("HTTP 503");
    fetchFn.mockResolvedValueOnce(Response.json({ data: { results: [] } }));
    await expect(tool("search_periodicals").execute("search", { query: "黄河" }, undefined)).rejects.toThrow("无效结果");
    fetchFn.mockResolvedValueOnce(Response.json({ data: { total: 0, results: [] } }));
    expect((await tool("search_periodicals").execute("search", { query: "黄河" }, undefined)).details)
      .toMatchObject({ total: 0, hits: [], hasMore: false });
  });
});
