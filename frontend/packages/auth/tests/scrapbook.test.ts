import { describe, expect, it, vi } from "vitest";
import type { JojoAuthClient } from "../src/client";
import { createScrapbookRepository, safeScrapbookPath, scrapbookMarkdown, validateScrapbookDraft, type ScrapbookDraft, type ScrapbookEntry } from "../src/scrapbook";

const draft: ScrapbookDraft = { contentType: "book", contentId: "demo:one", contentTitle: "示例书", sectionId: "chapter-1", locationLabel: "第一章", contentUrl: "/book/demo/one?chapter=chapter-1&quote=%E5%8E%9F%E6%96%87", quote: " 原文 ", note: " 笔记 ", collection: "专题" };
const row = { id: "clip-one", content_type: "book", content_id: "demo:one", content_title: "示例书", section_id: "chapter-1", location_label: "第一章", content_url: draft.contentUrl, quote: "原文", note: "笔记", collection: "专题", created_at: "2026-09-08T00:00:00Z", updated_at: "2026-09-08T00:00:00Z" };
function setup(data: unknown = row, ownerId = "owner-a") {
  const rpc = vi.fn().mockResolvedValue({ data, error: null });
  return { rpc, repo: createScrapbookRepository({ rpc } as unknown as JojoAuthClient, ownerId) };
}
describe("private scrapbook repository", () => {
  it("binds the saved citation to the initiating account", async () => {
    const { repo, rpc } = setup();
    const result = await repo.save(draft);
    expect(result).toMatchObject({ id: "clip-one", contentTitle: "示例书", quote: "原文", note: "笔记", sectionId: "chapter-1" });
    expect(rpc).toHaveBeenCalledWith("save_reader_clipping", expect.objectContaining({ p_expected_user_id: "owner-a", p_id: null, p_quote: "原文", p_content_url: draft.contentUrl }));
  });
  it("sends the same owner guard for pagination, filters and deletion", async () => {
    const { repo, rpc } = setup([]);
    await repo.list(" 原文 ", "*", 50); await repo.collections(); await repo.remove("clip-one");
    expect(rpc.mock.calls[0]).toEqual(["get_reader_clippings", { p_query: "原文", p_collection: "*", p_offset: 50, p_limit: 50, p_expected_user_id: "owner-a" }]);
    expect(rpc.mock.calls[1]).toEqual(["get_reader_clipping_collections", { p_expected_user_id: "owner-a" }]);
    expect(rpc.mock.calls[2]).toEqual(["delete_reader_clipping", { p_id: "clip-one", p_expected_user_id: "owner-a" }]);
  });
  it("does not acknowledge saving when the RPC fails or has no receipt", async () => {
    const { repo, rpc } = setup(null);
    await expect(repo.save(draft)).rejects.toThrow();
    rpc.mockResolvedValue({ data: { id: "receipt-without-source" }, error: null });
    await expect(repo.save(draft)).rejects.toThrow("数据格式无效");
    rpc.mockResolvedValue({ data: null, error: { message: "database unavailable" } });
    await expect(repo.save(draft)).rejects.toThrow("无法连接");
  });
  it("requires an account even if called outside the UI", async () => {
    const { repo, rpc } = setup(null, "");
    await expect(repo.save(draft)).rejects.toThrow("登录");
    expect(rpc).not.toHaveBeenCalled();
  });
  it("allows a note-only clipping while preserving its source", () => {
    expect(validateScrapbookDraft({ ...draft, quote: "" }).note).toBe("笔记");
    expect(() => validateScrapbookDraft({ ...draft, quote: " ", note: " " })).toThrow("摘录或笔记");
    expect(() => validateScrapbookDraft({ ...draft, quote: "字".repeat(6001) })).toThrow("过长");
  });
  it.each(["https://outside.invalid", "//outside.invalid", "/book/../../account", "/book/a b", "/book/a\\b", "/archive/x\ny", "javascript:alert(1)"])("rejects unsafe original link %s", (path) => {
    expect(safeScrapbookPath(path)).toBeUndefined();
  });
  it("exports the source and paragraph boundaries without executable HTML", () => {
    const entry: ScrapbookEntry = { ...draft, id: "one", createdAt: "", updatedAt: "", quote: "<img src=x>\n另一段", note: "[链接](bad)", contentTitle: "# 标题" };
    const markdown = scrapbookMarkdown([entry]);
    expect(markdown).toContain("> \\<img src=x\\>");
    expect(markdown).toContain("\n> 另一段");
    expect(markdown).toContain("https://reader.jojokanbao.cn/book/demo/one");
    expect(markdown).not.toContain("<img src=x>");
    expect(markdown).toContain("专题：专题");
  });
});
