import { describe, expect, it, vi } from "vitest";
import {
  createAnnotationApi,
  type AnnotationApiDependencies,
  type AnnotationSubject,
  type AnnotationThread,
  type TextAnchor,
} from "../src/annotations";

const subject: AnnotationSubject = {
  contentType: "book", contentId: "book:one", sectionId: "chapter:one", contentTitle: "示例书",
};
const anchor: TextAnchor = { quote: "示例正文", prefix: "前", suffix: "后", startOffset: 3, endOffset: 7 };

function thread(id: string, authorId = "reader:a"): AnnotationThread {
  return {
    ...subject, ...anchor, id, authorId, authorName: authorId,
    createdAt: "2026-09-12T00:00:00Z", underlinedByMe: true, comments: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

type RpcResult = Awaited<ReturnType<AnnotationApiDependencies["rpc"]>>;

function setup() {
  const rpc = vi.fn<AnnotationApiDependencies["rpc"]>().mockResolvedValue({ data: thread("one"), error: null });
  const getCurrentUserId = vi.fn<AnnotationApiDependencies["getCurrentUserId"]>().mockResolvedValue("reader:a");
  const api = createAnnotationApi({ rpc, getCurrentUserId, currentPath: () => "/reader/book?chapter=one" });
  return { rpc, getCurrentUserId, api };
}

describe("shared annotation API", () => {
  it("sends private visibility explicitly and preserves public RPC compatibility", async () => {
    const { api, rpc } = setup();
    await api.createAnnotation(subject, anchor, "  私密想法  ", "private");
    expect(rpc).toHaveBeenLastCalledWith("create_content_annotation", {
      p_content_type: "book", p_content_id: "book:one", p_section_id: "chapter:one",
      p_content_title: "示例书", p_content_url: "/reader/book?chapter=one", p_quote: "示例正文",
      p_prefix: "前", p_suffix: "后", p_start_offset: 3, p_end_offset: 7,
      p_initial_comment: "私密想法", p_initial_comment_visibility: "private",
    }, "reader:a");
    await api.addAnnotationComment("one", "  私密回复  ", "parent", "private");
    expect(rpc).toHaveBeenLastCalledWith("add_annotation_comment", {
      p_annotation_id: "one", p_body: "私密回复", p_parent_comment_id: "parent", p_visibility: "private",
    }, "reader:a");
    await api.createAnnotation(subject, anchor, "公开想法", "public");
    expect(rpc.mock.calls.at(-1)?.[1]).not.toHaveProperty("p_initial_comment_visibility");
    await api.addAnnotationComment("one", "公开回复");
    expect(rpc.mock.calls.at(-1)?.[1]).not.toHaveProperty("p_visibility");
  });

  it("does not retry a rejected private write with public visibility", async () => {
    const { api, rpc } = setup();
    rpc.mockResolvedValue({ data: null, error: { message: "Private comments are not enabled" } });
    await expect(api.createAnnotation(subject, anchor, "不能公开的内容", "private"))
      .rejects.toThrow("Private comments are not enabled");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0]?.[1]).toHaveProperty("p_initial_comment_visibility", "private");
  });

  it.each(["discussion", "create", "comment", "report"] as const)("rejects a stale %s response after switching accounts", async (operation) => {
    const { api, rpc, getCurrentUserId } = setup();
    const pending = deferred<RpcResult>();
    rpc.mockReturnValue(pending.promise);
    const request = operation === "discussion" ? api.loadAnnotationThreads(subject)
      : operation === "create" ? api.createAnnotation(subject, anchor)
        : operation === "comment" ? api.addAnnotationComment("one", "回复")
          : api.reportAnnotationComment("comment", "spam");
    const rejected = expect(request).rejects.toThrow("登录状态已变化");
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    getCurrentUserId.mockResolvedValue("reader:b");
    pending.resolve({ data: operation === "discussion" ? [thread("a-private")] : thread("a-private"), error: null });
    await rejected;
  });

  it("rejects in-flight personal notes before progress can expose the previous reader's content", async () => {
    const { api, rpc, getCurrentUserId } = setup();
    const pending = deferred<RpcResult>();
    const onProgress = vi.fn();
    rpc.mockReturnValueOnce(pending.promise);
    const loading = api.loadMyBookAnnotations("book:one", ["chapter:one"], "reader:a", { onProgress });
    const rejected = expect(loading).rejects.toThrow("登录状态已变化");
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    getCurrentUserId.mockResolvedValue("reader:b");
    pending.resolve({ data: [thread("a-private")], error: null });
    await rejected;
    expect(onProgress).not.toHaveBeenCalled();

    rpc.mockResolvedValue({ data: [thread("b-private", "reader:b")], error: null });
    expect(await api.loadMyBookAnnotations("book:one", ["chapter:one"], "reader:b"))
      .toEqual([thread("b-private", "reader:b")]);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("rechecks identity before delivering a cached chapter", async () => {
    const { api, rpc, getCurrentUserId } = setup();
    rpc.mockResolvedValue({ data: [thread("a-private")], error: null });
    await api.loadMyBookAnnotations("book:one", ["chapter:one"], "reader:a");
    getCurrentUserId.mockResolvedValueOnce("reader:a").mockResolvedValue("reader:b");
    const onProgress = vi.fn();

    await expect(api.loadMyBookAnnotations("book:one", ["chapter:one"], "reader:a", { onProgress }))
      .rejects.toThrow("登录状态已变化");
    expect(onProgress).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("shares an in-flight chapter while allowing one native subscriber to abort independently", async () => {
    const { api, rpc } = setup();
    const pending = deferred<RpcResult>();
    rpc.mockReturnValueOnce(pending.promise);
    // React Native AbortSignal implementations need not expose throwIfAborted.
    const nativeSignal = { aborted: false };
    const onProgress = vi.fn();
    const first = api.loadMyBookAnnotations("book:one", ["chapter:one"], "reader:a", {
      signal: nativeSignal as AbortSignal, onProgress,
    });
    const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    const second = api.loadMyBookAnnotations("book:one", ["chapter:one"], "reader:a");
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    nativeSignal.aborted = true;
    pending.resolve({ data: [thread("one")], error: null });

    await rejected;
    expect(await second).toEqual([thread("one")]);
    expect(onProgress).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("keeps a refreshed cache when an earlier request finishes later", async () => {
    const { api, rpc } = setup();
    const previous = deferred<RpcResult>();
    const refreshed = deferred<RpcResult>();
    rpc.mockReturnValueOnce(previous.promise).mockReturnValueOnce(refreshed.promise);
    const oldLoading = api.loadMyBookAnnotations("book:one", ["chapter:one"], "reader:a");
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    const newLoading = api.loadMyBookAnnotations("book:one", ["chapter:one"], "reader:a", { refresh: true });
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    refreshed.resolve({ data: [thread("new")], error: null });
    await newLoading;
    previous.resolve({ data: [thread("old")], error: null });
    await oldLoading;

    expect(await api.loadMyBookAnnotations("book:one", ["chapter:one"], "reader:a")).toEqual([thread("new")]);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("does not share caches between separately configured clients", async () => {
    const first = setup();
    const second = setup();
    first.rpc.mockResolvedValue({ data: [thread("first-server")], error: null });
    second.rpc.mockResolvedValue({ data: [thread("second-server")], error: null });
    await first.api.loadMyBookAnnotations("book:one", ["chapter:one"], "reader:a");
    expect(await second.api.loadMyBookAnnotations("book:one", ["chapter:one"], "reader:a"))
      .toEqual([thread("second-server")]);
    expect(second.rpc).toHaveBeenCalledTimes(1);
  });

  it("stops starting later chapter batches if the account changes after partial progress", async () => {
    const { api, rpc, getCurrentUserId } = setup();
    rpc.mockResolvedValue({ data: [thread("a-private")], error: null });
    const onProgress = vi.fn(() => { getCurrentUserId.mockResolvedValue("reader:b"); });

    await expect(api.loadMyBookAnnotations("book:one", ["one", "two", "three", "four", "five"], "reader:a", { onProgress }))
      .rejects.toThrow("登录状态已变化");
    expect(rpc).toHaveBeenCalledTimes(4);
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it("does not make authenticated read or write calls after sign-out", async () => {
    const { api, rpc, getCurrentUserId } = setup();
    getCurrentUserId.mockResolvedValue(null);
    await expect(api.loadAnnotationThreads(subject)).rejects.toThrow("请先登录");
    await expect(api.createAnnotation(subject, anchor)).rejects.toThrow("请先登录");
    await expect(api.addAnnotationComment("one", "回复")).rejects.toThrow("请先登录");
    await expect(api.reportAnnotationComment("comment", "other")).rejects.toThrow("请先登录");
    expect(await api.loadMyBookAnnotations("book:one", ["chapter:one"], null)).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects the caller's stale identity before any read or write transport", async () => {
    const { api, rpc, getCurrentUserId } = setup();
    getCurrentUserId.mockResolvedValue("reader:b");
    await expect(api.createAnnotation(subject, anchor, "旧草稿", "private", "reader:a")).rejects.toThrow("登录状态已变化");
    await expect(api.addAnnotationComment("one", "旧回复", undefined, "private", "reader:a")).rejects.toThrow("登录状态已变化");
    await expect(api.reportAnnotationComment("comment", "spam", undefined, "reader:a")).rejects.toThrow("登录状态已变化");
    await expect(api.loadAnnotationThreads(subject, "reader:a")).rejects.toThrow("登录状态已变化");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("passes the captured identity to every authenticated transport", async () => {
    const { api, rpc } = setup();
    await api.createAnnotation(subject, anchor);
    await api.addAnnotationComment("one", "回复");
    await api.reportAnnotationComment("comment", "spam");
    rpc.mockResolvedValue({ data: [], error: null });
    await api.loadAnnotationThreads(subject);
    await api.loadMyBookAnnotations("book:one", ["one", "two", "three", "four", "five"], "reader:a");
    expect(rpc).toHaveBeenCalledTimes(9);
    expect(rpc.mock.calls.every(([, , expectedUserId]) => expectedUserId === "reader:a")).toBe(true);
  });
});
