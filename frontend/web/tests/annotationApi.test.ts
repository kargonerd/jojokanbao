import { beforeEach, describe, expect, it, vi } from "vitest";
import { addAnnotationComment, createAnnotation, deleteMyAnnotationMark, setAnnotationCommentLike } from "../src/annotations/api";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("../src/account/auth", () => ({
  authClient: { rpc },
}));

const subject = {
  contentType: "book" as const,
  contentId: "book:one",
  sectionId: "chapter:one",
  contentTitle: "示例书",
  contentUrl: "/book/one",
};

const anchor = {
  quote: "被划线的正文",
  prefix: "前文",
  suffix: "后文",
  startOffset: 10,
  endOffset: 17,
};

describe("annotation API compatibility", () => {
  it("deletes the authenticated reader's mark and accepts a no-longer-visible thread", async () => {
    rpc.mockResolvedValue({ data: { thread: null }, error: null });
    await expect(deleteMyAnnotationMark("annotation:one")).resolves.toBeNull();
    expect(rpc).toHaveBeenLastCalledWith("delete_my_annotation_mark", { p_annotation_id: "annotation:one" });
    rpc.mockResolvedValue({ data: null, error: { message: "删除失败" } });
    await expect(deleteMyAnnotationMark("annotation:one")).rejects.toThrow("删除失败");
  });
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockResolvedValue({ data: { id: "annotation:one" }, error: null });
  });

  it("uses the database default for public annotations", async () => {
    await createAnnotation(subject, anchor);

    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc.mock.calls[0]?.[0]).toBe("create_content_annotation");
    expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty("p_initial_comment_visibility");
  });

  it("sends visibility explicitly for private thoughts", async () => {
    await createAnnotation(subject, anchor, "自己的想法", "private");

    expect(rpc.mock.calls[0]?.[1]).toHaveProperty("p_initial_comment_visibility", "private");
  });

  it("uses the database default for public replies", async () => {
    await addAnnotationComment("annotation:one", "公开回复");

    expect(rpc.mock.calls[0]?.[0]).toBe("add_annotation_comment");
    expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty("p_visibility");
  });
  it("sets and clears likes idempotently and propagates service errors", async () => {
    rpc.mockResolvedValue({ data: { id: "comment-1", likeCount: 3, likedByMe: true }, error: null });
    await expect(setAnnotationCommentLike("comment-1", true)).resolves.toEqual({ id: "comment-1", likeCount: 3, likedByMe: true });
    expect(rpc).toHaveBeenLastCalledWith("set_annotation_comment_like", { p_comment_id: "comment-1", p_liked: true });
    rpc.mockResolvedValue({ data: null, error: { message: "Public comment not found" } });
    await expect(setAnnotationCommentLike("comment-1", false)).rejects.toThrow("Public comment not found");
    expect(rpc).toHaveBeenLastCalledWith("set_annotation_comment_like", { p_comment_id: "comment-1", p_liked: false });
  });
});
