import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnnotationComment, AnnotationThread } from "../src/annotations/types";

const { rpc, getSession, setHeader } = vi.hoisted(() => ({ rpc: vi.fn(), getSession: vi.fn(), setHeader: vi.fn() }));
let api: typeof import("../src/annotations/api");

vi.mock("../src/account/auth", () => ({
  authClient: {
    rpc: (name: string, params: Record<string, unknown>) => ({ setHeader: (header: string, value: string) => {
      setHeader(header, value);
      return rpc(name, params);
    } }),
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
  beforeEach(async () => {
    vi.resetModules();
    api = await import("../src/annotations/api");
    rpc.mockReset();
    rpc.mockResolvedValue({ data: { id: "annotation:one" }, error: null });
    getSession.mockReset();
    getSession.mockResolvedValue({ data: { session: { user: { id: "reader:me" }, access_token: "token-me" } }, error: null });
    setHeader.mockReset();
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

  it("reuses chapter discussions, keeping only personal underlines and thoughts", async () => {
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
    ], error: null }).mockResolvedValueOnce({ data: [
      thread("second-chapter", { sectionId: "chapter:two", underlinedByMe: true }),
    ], error: null });

    const notes = await api.loadMyBookAnnotations("book:one", ["chapter:one", "chapter:two", "chapter:one"], "reader:me");
    expect(notes.map((note) => note.id)).toEqual(["own-mark", "shared-mark-with-my-thought", "legacy-own", "second-chapter"]);
    expect(notes[0]?.comments).toEqual([ownPublic, ownPrivate]);
    expect(notes[1]?.comments).toEqual([ownPrivate]);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenNthCalledWith(1, "get_annotation_threads", {
      p_content_type: "book", p_content_id: "book:one", p_section_id: "chapter:one",
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "get_annotation_threads", {
      p_content_type: "book", p_content_id: "book:one", p_section_id: "chapter:two",
    });
  });

  it("reuses successful chapters when retrying an error, without reporting a false zero", async () => {
    rpc.mockResolvedValueOnce({ data: [thread("own-mark", { underlinedByMe: true })], error: null });
    rpc.mockResolvedValueOnce({ data: null, error: { message: "Reader annotations are not enabled" } });
    await expect(api.loadMyBookAnnotations("book:one", ["one", "two"], "reader:me")).rejects.toThrow("Reader annotations are not enabled");
    rpc.mockResolvedValue({ data: [], error: null });
    expect(await api.loadMyBookAnnotations("book:one", ["one", "two"], "reader:me")).toHaveLength(1);
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(rpc.mock.calls[2]?.[1]).toHaveProperty("p_section_id", "two");
  });

  it("caches repeated tool openings for one minute and permits explicit refresh", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
    rpc.mockResolvedValue({ data: [thread("one", { underlinedByMe: true })], error: null });
    await api.loadMyBookAnnotations("book:one", ["one"], "reader:me");
    now.mockReturnValue(159_999);
    await api.loadMyBookAnnotations("book:one", ["one"], "reader:me");
    expect(rpc).toHaveBeenCalledTimes(1);
    now.mockReturnValue(160_000);
    await api.loadMyBookAnnotations("book:one", ["one"], "reader:me");
    expect(rpc).toHaveBeenCalledTimes(2);
    await api.loadMyBookAnnotations("book:one", ["one"], "reader:me", { refresh: true });
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it("reloads only the affected chapter after adding an underline or thought", async () => {
    rpc.mockImplementation(async (name: string) => name === "get_annotation_threads"
      ? { data: [thread("one", { underlinedByMe: true })], error: null }
      : { data: thread("one", { underlinedByMe: true }), error: null });
    await api.loadMyBookAnnotations("book:one", ["chapter:one", "chapter:two"], "reader:me");
    await api.createAnnotation(subject, anchor);
    await api.loadMyBookAnnotations("book:one", ["chapter:one", "chapter:two"], "reader:me");
    expect(rpc.mock.calls.filter(([name]) => name === "get_annotation_threads")).toHaveLength(3);
    await api.addAnnotationComment("one", "新想法");
    await api.loadMyBookAnnotations("book:one", ["chapter:one", "chapter:two"], "reader:me");
    expect(rpc.mock.calls.filter(([name]) => name === "get_annotation_threads")).toHaveLength(4);
  });

  it("bounds chapter requests and reports partial results before the full book finishes", async () => {
    const pending: Array<() => void> = [];
    rpc.mockImplementation((_name: string, params: { p_section_id: string }) => new Promise((resolve) => {
      pending.push(() => resolve({ data: [thread(params.p_section_id, { underlinedByMe: true })], error: null }));
    }));
    const onProgress = vi.fn();
    const loading = api.loadMyBookAnnotations("book:one", ["one", "two", "three", "four", "five"], "reader:me", { onProgress });
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(4));
    expect(onProgress).not.toHaveBeenCalled();
    pending.slice(0, 4).forEach((resolve) => resolve());
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(5));
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ loadedSections: 4, totalSections: 5 }));
    expect(onProgress.mock.calls[0]?.[0].notes).toHaveLength(4);
    pending[4]!();
    expect(await loading).toHaveLength(5);
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ loadedSections: 5, totalSections: 5 }));
  });

  it("stops starting further chapters when the reader closes the panel", async () => {
    const controller = new AbortController();
    const pending: Array<() => void> = [];
    rpc.mockImplementation(() => new Promise((resolve) => pending.push(() => resolve({ data: [], error: null }))));
    const loading = api.loadMyBookAnnotations("book:one", ["one", "two", "three", "four", "five"], "reader:me", { signal: controller.signal });
    const rejected = expect(loading).rejects.toThrow();
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(4));
    controller.abort();
    pending.forEach((resolve) => resolve());
    await rejected;
    expect(rpc).toHaveBeenCalledTimes(4);
  });

  it("separates cached readers and rejects results after an account switch", async () => {
    rpc.mockResolvedValue({ data: [thread("one", { underlinedByMe: true })], error: null });
    await api.loadMyBookAnnotations("book:one", ["one"], "reader:me");
    getSession.mockResolvedValue({ data: { session: { user: { id: "reader:other" }, access_token: "token-other" } }, error: null });
    await api.loadMyBookAnnotations("book:one", ["one"], "reader:other");
    expect(rpc).toHaveBeenCalledTimes(2);
    await expect(api.loadMyBookAnnotations("book:one", ["one"], "reader:me")).rejects.toThrow("登录状态已变化");
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("does not request or expose personal notes to signed-out readers", async () => {
    expect(await api.loadMyBookAnnotations("book:one", ["one"], null)).toEqual([]);
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
