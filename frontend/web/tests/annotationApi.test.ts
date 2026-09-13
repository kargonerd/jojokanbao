import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnnotationComment, AnnotationThread } from "../src/annotations/types";

const { rpc, getSession, setHeader, abortSignal } = vi.hoisted(() => ({ rpc: vi.fn(), getSession: vi.fn(), setHeader: vi.fn(), abortSignal: vi.fn() }));
let api: typeof import("../src/annotations/api");

vi.mock("../src/account/auth", () => ({
  authClient: {
    rpc: (name: string, params: Record<string, unknown>) => {
      const request = {
        setHeader: (header: string, value: string) => { setHeader(header, value); return request; },
        abortSignal: (signal: AbortSignal) => { abortSignal(signal); return request; },
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(rpc(name, params)).then(resolve, reject),
      };
      return request;
    },
    auth: { getSession },
  },
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

function thread(id: string, overrides: Partial<AnnotationThread> = {}): AnnotationThread {
  return {
    ...subject, ...anchor, id, authorId: "reader:other", authorName: "另一位读者",
    createdAt: "2026-09-12T00:00:00Z", underlinedByMe: false, comments: [], ...overrides,
  };
}

function comment(id: string, authorId: string, visibility: "public" | "private" = "public"): AnnotationComment {
  return {
    id, annotationId: "one", parentCommentId: null, authorId, authorName: authorId,
    body: id, visibility, createdAt: "2026-09-12T00:00:00Z", reportedByMe: false,
  };
}

describe("annotation API compatibility", () => {
  it("deletes the authenticated reader's mark and accepts a no-longer-visible thread", async () => {
    rpc.mockResolvedValue({ data: { thread: null }, error: null });
    await expect(api.deleteMyAnnotationMark("annotation:one")).resolves.toBeNull();
    expect(rpc).toHaveBeenLastCalledWith("delete_my_annotation_mark", { p_annotation_id: "annotation:one" });
    rpc.mockResolvedValue({ data: null, error: { message: "删除失败" } });
    await expect(api.deleteMyAnnotationMark("annotation:one")).rejects.toThrow("删除失败");
  });

  it("deletes the authenticated reader's comment and invalidates cache", async () => {
    rpc.mockResolvedValue({ data: { annotationId: "annotation:one", thread: null }, error: null });
    await expect(api.deleteMyAnnotationComment("comment-1")).resolves.toEqual({ annotationId: "annotation:one", thread: null });
    expect(rpc).toHaveBeenLastCalledWith("delete_my_annotation_comment", { p_comment_id: "comment-1" });
    rpc.mockResolvedValue({ data: null, error: { message: "Comment not found or already deleted" } });
    await expect(api.deleteMyAnnotationComment("comment-1")).rejects.toThrow("Comment not found or already deleted");
  });

  it("sets and clears likes idempotently and propagates service errors", async () => {
    rpc.mockResolvedValue({ data: { id: "comment-1", likeCount: 3, likedByMe: true }, error: null });
    await expect(api.setAnnotationCommentLike("comment-1", true)).resolves.toEqual({ id: "comment-1", likeCount: 3, likedByMe: true });
    expect(rpc).toHaveBeenLastCalledWith("set_annotation_comment_like", { p_comment_id: "comment-1", p_liked: true });
    rpc.mockResolvedValue({ data: null, error: { message: "Public comment not found" } });
    await expect(api.setAnnotationCommentLike("comment-1", false)).rejects.toThrow("Public comment not found");
    expect(rpc).toHaveBeenLastCalledWith("set_annotation_comment_like", { p_comment_id: "comment-1", p_liked: false });
  });

  beforeEach(async () => {
    vi.resetModules();
    api = await import("../src/annotations/api");
    rpc.mockReset();
    rpc.mockResolvedValue({ data: { id: "annotation:one" }, error: null });
    getSession.mockReset();
    getSession.mockResolvedValue({ data: { session: { user: { id: "reader:me" }, access_token: "token-me" } }, error: null });
    setHeader.mockReset();
    abortSignal.mockReset();
  });

  afterEach(() => vi.restoreAllMocks());

  it("uses the database default for public annotations", async () => {
    await api.createAnnotation(subject, anchor);

    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc.mock.calls[0]?.[0]).toBe("create_content_annotation");
    expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty("p_initial_comment_visibility");
  });

  it("sends visibility explicitly for private thoughts", async () => {
    await api.createAnnotation(subject, anchor, "自己的想法", "private");

    expect(rpc.mock.calls[0]?.[1]).toHaveProperty("p_initial_comment_visibility", "private");
  });

  it("uses the database default for public replies", async () => {
    await api.addAnnotationComment("annotation:one", "公开回复");

    expect(rpc.mock.calls[0]?.[0]).toBe("add_annotation_comment");
    expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty("p_visibility");
  });

  it("reads the whole book without a chapter scan and keeps only personal underlines and thoughts", async () => {
    const ownPublic = comment("自己的公开想法", "reader:me");
    const ownPrivate = comment("自己的私密想法", "reader:me", "private");
    const other = comment("别人的公开讨论", "reader:other");
    rpc.mockResolvedValueOnce({ data: [
      thread("own-mark", { underlinedByMe: true, comments: [ownPublic, ownPrivate, other] }),
      thread("shared-mark-with-my-thought", { comments: [ownPrivate, other] }),
      thread("someone-else", { comments: [other] }),
      thread("legacy-own", { underlinedByMe: undefined, authorId: "reader:me" }),
      thread("legacy-other", { underlinedByMe: undefined }),
      thread("former-author", { authorId: "reader:me" }),
      thread("second-chapter", { sectionId: "chapter:two", underlinedByMe: true }),
    ], error: null });

    const notes = await api.loadMyBookAnnotations("book:one", "reader:me");
    expect(notes.map((note) => note.id)).toEqual(["own-mark", "shared-mark-with-my-thought", "legacy-own", "second-chapter"]);
    expect(notes[0]?.comments).toEqual([ownPublic, ownPrivate]);
    expect(notes[1]?.comments).toEqual([ownPrivate]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenLastCalledWith("get_my_book_annotations", {
      p_content_id: "book:one", p_after_id: null, p_limit: 100,
    });
    expect(abortSignal).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
  });

  it("restarts failed paginated reads without reporting a false zero or reusing partial data", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => thread(`own-${index}`, { underlinedByMe: true }));
    const onProgress = vi.fn();
    rpc.mockResolvedValueOnce({ data: firstPage, error: null });
    rpc.mockResolvedValueOnce({ data: null, error: { message: "Reader annotations are not enabled" } });
    await expect(api.loadMyBookAnnotations("book:one", "reader:me", { onProgress })).rejects.toThrow("Reader annotations are not enabled");
    expect(onProgress).toHaveBeenCalledExactlyOnceWith({ notes: firstPage, complete: false });
    const fresh = thread("fresh", { underlinedByMe: true });
    rpc.mockResolvedValue({ data: [fresh], error: null });
    expect(await api.loadMyBookAnnotations("book:one", "reader:me")).toEqual([fresh]);
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(rpc.mock.calls[2]?.[1]).toEqual({ p_content_id: "book:one", p_after_id: null, p_limit: 100 });
  });

  it("caches repeated tool openings for one minute and permits explicit refresh", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
    rpc.mockResolvedValue({ data: [thread("one", { underlinedByMe: true })], error: null });
    await api.loadMyBookAnnotations("book:one", "reader:me");
    now.mockReturnValue(159_999);
    await api.loadMyBookAnnotations("book:one", "reader:me");
    expect(rpc).toHaveBeenCalledTimes(1);
    now.mockReturnValue(160_000);
    await api.loadMyBookAnnotations("book:one", "reader:me");
    expect(rpc).toHaveBeenCalledTimes(2);
    await api.loadMyBookAnnotations("book:one", "reader:me", { refresh: true });
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it("invalidates the book after adding an underline or thought", async () => {
    rpc.mockImplementation(async (name: string) => name === "get_my_book_annotations"
      ? { data: [thread("one", { underlinedByMe: true })], error: null }
      : name === "delete_my_annotation_comment"
      ? { data: { annotationId: "one", thread: null }, error: null }
      : { data: thread("one", { underlinedByMe: true }), error: null });
    await api.loadMyBookAnnotations("book:one", "reader:me");
    await api.createAnnotation(subject, anchor);
    await api.loadMyBookAnnotations("book:one", "reader:me");
    expect(rpc.mock.calls.filter(([name]) => name === "get_my_book_annotations")).toHaveLength(2);
    await api.addAnnotationComment("one", "新想法");
    await api.loadMyBookAnnotations("book:one", "reader:me");
    expect(rpc.mock.calls.filter(([name]) => name === "get_my_book_annotations")).toHaveLength(3);
    await api.deleteMyAnnotationComment("comment-1");
    await api.loadMyBookAnnotations("book:one", "reader:me");
    expect(rpc.mock.calls.filter(([name]) => name === "get_my_book_annotations")).toHaveLength(4);
  });

  it("loads 101 notes in two serial pages using one abortable transport per book read", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => thread(`own-${index}`, { underlinedByMe: true }));
    const last = thread("own-last", { underlinedByMe: true });
    let finish!: () => void;
    rpc.mockResolvedValueOnce({ data: firstPage, error: null })
      .mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ data: [last], error: null }); }));
    const onProgress = vi.fn();
    const loading = api.loadMyBookAnnotations("book:one", "reader:me", { onProgress });
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    expect(rpc).toHaveBeenLastCalledWith("get_my_book_annotations", {
      p_content_id: "book:one", p_after_id: "own-99", p_limit: 100,
    });
    expect(onProgress).toHaveBeenCalledExactlyOnceWith({ notes: firstPage, complete: false });
    expect(abortSignal.mock.calls[0]?.[0]).toBe(abortSignal.mock.calls[1]?.[0]);
    finish();
    expect(await loading).toEqual([...firstPage, last]);
    expect(onProgress).toHaveBeenLastCalledWith({ notes: [...firstPage, last], complete: true });
  });

  it("cancels the Supabase request immediately on close and opens a fresh request on retry", async () => {
    const controller = new AbortController();
    let finish!: () => void;
    rpc.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ data: [], error: null }); }));
    const loading = api.loadMyBookAnnotations("book:one", "reader:me", { signal: controller.signal });
    const rejected = expect(loading).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    const nativeSignal = abortSignal.mock.calls[0]?.[0] as AbortSignal;
    controller.abort();
    await rejected;
    expect(nativeSignal.aborted).toBe(true);
    const fresh = thread("fresh", { underlinedByMe: true });
    rpc.mockResolvedValueOnce({ data: [fresh], error: null });
    expect(await api.loadMyBookAnnotations("book:one", "reader:me")).toEqual([fresh]);
    expect(abortSignal.mock.calls[1]?.[0]).not.toBe(nativeSignal);
    finish();
    expect(await api.loadMyBookAnnotations("book:one", "reader:me")).toEqual([fresh]);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("separates cached books and readers and rejects a stale account", async () => {
    rpc.mockResolvedValue({ data: [thread("one", { underlinedByMe: true })], error: null });
    await api.loadMyBookAnnotations("book:one", "reader:me");
    await api.loadMyBookAnnotations("book:two", "reader:me");
    expect(rpc).toHaveBeenLastCalledWith("get_my_book_annotations", { p_content_id: "book:two", p_after_id: null, p_limit: 100 });
    getSession.mockResolvedValue({ data: { session: { user: { id: "reader:other" }, access_token: "token-other" } }, error: null });
    await api.loadMyBookAnnotations("book:one", "reader:other");
    expect(rpc).toHaveBeenCalledTimes(3);
    await expect(api.loadMyBookAnnotations("book:one", "reader:me")).rejects.toThrow("登录状态已变化");
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it("does not request or expose personal notes to signed-out readers", async () => {
    expect(await api.loadMyBookAnnotations("book:one", null)).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });

  it("rejects a switched session before constructing a write request", async () => {
    getSession.mockResolvedValueOnce({ data: { session: { user: { id: "reader:me" }, access_token: "token-me" } }, error: null })
      .mockResolvedValue({ data: { session: { user: { id: "reader:other" }, access_token: "token-other" } }, error: null });
    await expect(api.createAnnotation(subject, anchor, "旧账号草稿", "private")).rejects.toThrow("登录状态已变化");
    expect(rpc).not.toHaveBeenCalled();
    expect(setHeader).not.toHaveBeenCalled();
  });

  it("pins Authorization to the captured session even if live auth switches before transport", async () => {
    setHeader.mockImplementation(() => {
      getSession.mockResolvedValue({ data: { session: { user: { id: "reader:other" }, access_token: "token-other" } }, error: null });
    });
    await expect(api.createAnnotation(subject, anchor, "自己的草稿", "private", "reader:me")).rejects.toThrow("登录状态已变化");
    expect(setHeader).toHaveBeenCalledTimes(1);
    expect(setHeader).toHaveBeenLastCalledWith("Authorization", "Bearer token-me");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
