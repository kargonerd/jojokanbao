import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("times out a stalled public request and rejects a non-advancing page", async () => {
    vi.useFakeTimers(); const {api,rpc}=setup();
    rpc.mockReturnValueOnce(new Promise(()=>{}));
    const loading=api.loadPublicBookAnnotations("book:one","reader:a");
    const assertion=expect(loading).rejects.toThrow("笔记读取超时");
    await vi.advanceTimersByTimeAsync(15_000); await assertion;
    expect(rpc.mock.lastCall?.[3]?.aborted).toBe(true);
    rpc.mockResolvedValue({data:Array.from({length:100},()=>({...thread("same"),publiclyVisible:true})),error:null});
    await expect(api.loadPublicBookAnnotations("book:one","reader:a",{afterId:"same"})).rejects.toThrow("笔记分页未能继续");
  });

  it("reads one public page and strips all private comments, including the caller's", async () => {
    const {api,rpc}=setup();
    const comment = {id:"c",annotationId:"public",parentCommentId:null,authorId:"reader:a",authorName:"A",body:"private",visibility:"private" as const,createdAt:"2026-09-13",reportedByMe:false};
    rpc.mockResolvedValue({data:[{...thread("public","reader:b"),publiclyVisible:true,comments:[comment,{...comment,id:"p",authorId:"reader:b",body:"public",visibility:"public"}]},{...thread("private"),publiclyVisible:false}],error:null});
    const page=await api.loadPublicBookAnnotations("book:one","reader:a");
    expect(page.notes).toHaveLength(1);
    expect(page.notes[0]?.comments.map((entry)=>entry.body)).toEqual(["public"]);
    expect(page.nextCursor).toBeNull();
    expect(rpc).toHaveBeenCalledExactlyOnceWith("get_public_book_annotations",{p_content_id:"book:one",p_after_id:null,p_limit:100},"reader:a",expect.any(AbortSignal));
  });
  it("does not automatically fetch the next hundred public notes or share the personal cache", async () => {
    const {api,rpc}=setup();
    rpc.mockResolvedValueOnce({data:[],error:null});
    await api.loadMyBookAnnotations("book:one","reader:a");
    const notes=Array.from({length:100},(_,i)=>({...thread(String(i).padStart(3,"0"),"reader:b"),publiclyVisible:true}));
    rpc.mockResolvedValueOnce({data:notes,error:null});
    const page=await api.loadPublicBookAnnotations("book:one","reader:a");
    expect(page.notes).toHaveLength(100);expect(page.nextCursor).toBe("099");expect(rpc).toHaveBeenCalledTimes(2);
    rpc.mockResolvedValueOnce({data:[],error:null});
    expect(await api.loadPublicBookAnnotations("book:one","reader:a",{afterId:page.nextCursor})).toEqual({notes:[],nextCursor:null});
    expect(rpc.mock.lastCall?.[1]).toMatchObject({p_after_id:"099"});
  });
  it("rejects public data arriving after an account switch", async () => {
    const {api,rpc,getCurrentUserId}=setup();const pending=deferred<RpcResult>();rpc.mockReturnValue(pending.promise);
    const loading=api.loadPublicBookAnnotations("book:one","reader:a");
    await vi.waitFor(()=>expect(rpc).toHaveBeenCalled());
    getCurrentUserId.mockResolvedValue("reader:b");
    pending.resolve({data:[],error:null});await expect(loading).rejects.toThrow("登录状态已变化");
  });
  it("aborts public transport when the panel closes", async () => {
    const {api,rpc}=setup();rpc.mockReturnValue(new Promise(()=>{}));const controller=new AbortController();
    const loading=api.loadPublicBookAnnotations("book:one","reader:a",{signal:controller.signal});
    await vi.waitFor(()=>expect(rpc).toHaveBeenCalled());const assertion=expect(loading).rejects.toMatchObject({name:"AbortError"});
    controller.abort();await assertion;expect(rpc.mock.lastCall?.[3]?.aborted).toBe(true);
  });

  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each(["like", "delete"] as const)("invalidates the affected book only after a successful %s", async (operation) => {
    const { api, rpc } = setup();
    const entry = { ...thread("one"), comments: [{
      id: "comment", annotationId: "one", parentCommentId: null, authorId: "reader:a", authorName: "读者",
      body: "公开想法", visibility: "public" as const, createdAt: "2026-09-12T00:00:00Z", reportedByMe: false,
      likeCount: 0, likedByMe: false,
    }] };
    const untouched = { ...thread("two"), sectionId: "chapter:two" };
    let updated = false;
    let fail = true;
    rpc.mockImplementation(async (name) => {
      if (name === "get_my_book_annotations") {
        return { data: !updated ? [entry, untouched] : operation === "delete" ? [untouched]
          : [{ ...entry, comments: [{ ...entry.comments[0]!, likeCount: 1, likedByMe: true }] }, untouched], error: null };
      }
      if (fail) return { data: null, error: { message: "offline" } };
      updated = true;
      return { data: operation === "delete" ? { thread: null } : { id: "comment", likeCount: 1, likedByMe: true }, error: null };
    });
    const read = () => api.loadMyBookAnnotations("book:one", "reader:a");
    const mutate = () => operation === "delete" ? api.deleteMyAnnotationMark("one", "reader:a")
      : api.setAnnotationCommentLike("comment", true, "reader:a");
    expect(await read()).toEqual([entry, untouched]);
    await expect(mutate()).rejects.toThrow("offline");
    expect(await read()).toEqual([entry, untouched]);
    expect(rpc.mock.calls.filter(([name]) => name === "get_my_book_annotations")).toHaveLength(1);
    fail = false;
    await mutate();
    expect(rpc).toHaveBeenLastCalledWith(operation === "delete" ? "delete_my_annotation_mark" : "set_annotation_comment_like",
      operation === "delete" ? { p_annotation_id: "one" } : { p_comment_id: "comment", p_liked: true }, "reader:a");
    const notes = await read();
    expect(notes.find((note) => note.id === "two")).toEqual(untouched);
    if (operation === "delete") expect(notes.map((note) => note.id)).toEqual(["two"]);
    else expect(notes[0]?.comments[0]).toMatchObject({ likeCount: 1, likedByMe: true });
    expect(rpc.mock.calls.filter(([name]) => name === "get_my_book_annotations")).toHaveLength(2);
  });

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

  it.each(["discussion", "create", "comment", "report", "like", "delete"] as const)("rejects a stale %s response after switching accounts", async (operation) => {
    const { api, rpc, getCurrentUserId } = setup();
    const pending = deferred<RpcResult>();
    rpc.mockReturnValue(pending.promise);
    const request = operation === "discussion" ? api.loadAnnotationThreads(subject)
      : operation === "create" ? api.createAnnotation(subject, anchor)
        : operation === "comment" ? api.addAnnotationComment("one", "回复")
          : operation === "like" ? api.setAnnotationCommentLike("comment", true)
            : operation === "delete" ? api.deleteMyAnnotationMark("one")
              : api.reportAnnotationComment("comment", "spam");
    const rejected = expect(request).rejects.toThrow("登录状态已变化");
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    getCurrentUserId.mockResolvedValue("reader:b");
    pending.resolve({ data: operation === "discussion" ? [thread("a-private")]
      : operation === "delete" ? { thread: thread("a-private") }
        : operation === "like" ? { id: "comment", likeCount: 1, likedByMe: true } : thread("a-private"), error: null });
    await rejected;
  });

  it("rejects in-flight personal notes before progress can expose the previous reader's content", async () => {
    const { api, rpc, getCurrentUserId } = setup();
    const pending = deferred<RpcResult>();
    const onProgress = vi.fn();
    rpc.mockReturnValueOnce(pending.promise);
    const loading = api.loadMyBookAnnotations("book:one", "reader:a", { onProgress });
    const rejected = expect(loading).rejects.toThrow("登录状态已变化");
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    getCurrentUserId.mockResolvedValue("reader:b");
    pending.resolve({ data: [thread("a-private")], error: null });
    await rejected;
    expect(onProgress).not.toHaveBeenCalled();

    rpc.mockResolvedValue({ data: [thread("b-private", "reader:b")], error: null });
    expect(await api.loadMyBookAnnotations("book:one", "reader:b"))
      .toEqual([thread("b-private", "reader:b")]);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("rechecks identity before delivering a cached book", async () => {
    const { api, rpc, getCurrentUserId } = setup();
    rpc.mockResolvedValue({ data: [thread("a-private")], error: null });
    await api.loadMyBookAnnotations("book:one", "reader:a");
    getCurrentUserId.mockResolvedValueOnce("reader:a").mockResolvedValue("reader:b");
    const onProgress = vi.fn();

    await expect(api.loadMyBookAnnotations("book:one", "reader:a", { onProgress }))
      .rejects.toThrow("登录状态已变化");
    expect(onProgress).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("aborts immediately and lets a reopened panel make an independent request", async () => {
    const { api, rpc } = setup();
    const pending = deferred<RpcResult>();
    rpc.mockReturnValueOnce(pending.promise);
    const controller = new AbortController();
    // React Native AbortSignal implementations need not expose throwIfAborted.
    Object.defineProperty(controller.signal, "throwIfAborted", { value: undefined });
    const onProgress = vi.fn();
    const first = api.loadMyBookAnnotations("book:one", "reader:a", {
      signal: controller.signal, onProgress,
    });
    const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    const firstSignal = rpc.mock.calls[0]?.[3];
    expect(firstSignal).toBeInstanceOf(AbortSignal);
    controller.abort();
    await rejected;
    expect(firstSignal?.aborted).toBe(true);
    rpc.mockResolvedValueOnce({ data: [thread("fresh")], error: null });
    expect(await api.loadMyBookAnnotations("book:one", "reader:a")).toEqual([thread("fresh")]);
    expect(rpc.mock.calls[1]?.[3]).not.toBe(firstSignal);
    pending.resolve({ data: [thread("stale")], error: null });
    await pending.promise;
    expect(await api.loadMyBookAnnotations("book:one", "reader:a")).toEqual([thread("fresh")]);
    expect(onProgress).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("does not share pending requests or cancel another open panel", async () => {
    const { api, rpc } = setup();
    const firstPage = deferred<RpcResult>();
    const secondPage = deferred<RpcResult>();
    rpc.mockReturnValueOnce(firstPage.promise).mockReturnValueOnce(secondPage.promise);
    const controller = new AbortController();
    const first = api.loadMyBookAnnotations("book:one", "reader:a", { signal: controller.signal });
    const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    const second = api.loadMyBookAnnotations("book:one", "reader:a");
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    controller.abort();
    await rejected;
    expect(rpc.mock.calls[1]?.[3]?.aborted).toBe(false);
    secondPage.resolve({ data: [thread("second")], error: null });
    expect(await second).toEqual([thread("second")]);
    firstPage.resolve({ data: [thread("cancelled")], error: null });
  });

  it("keeps a refreshed cache when an earlier request finishes later", async () => {
    const { api, rpc } = setup();
    const previous = deferred<RpcResult>();
    const refreshed = deferred<RpcResult>();
    rpc.mockReturnValueOnce(previous.promise).mockReturnValueOnce(refreshed.promise);
    const oldLoading = api.loadMyBookAnnotations("book:one", "reader:a");
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    const newLoading = api.loadMyBookAnnotations("book:one", "reader:a", { refresh: true });
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    refreshed.resolve({ data: [thread("new")], error: null });
    await newLoading;
    previous.resolve({ data: [thread("old")], error: null });
    await oldLoading;

    expect(await api.loadMyBookAnnotations("book:one", "reader:a")).toEqual([thread("new")]);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("does not share caches between separately configured clients", async () => {
    const first = setup();
    const second = setup();
    first.rpc.mockResolvedValue({ data: [thread("first-server")], error: null });
    second.rpc.mockResolvedValue({ data: [thread("second-server")], error: null });
    await first.api.loadMyBookAnnotations("book:one", "reader:a");
    expect(await second.api.loadMyBookAnnotations("book:one", "reader:a"))
      .toEqual([thread("second-server")]);
    expect(second.rpc).toHaveBeenCalledTimes(1);
  });

  it("reads an empty book with one paginated RPC and caches the completed zero", async () => {
    const { api, rpc } = setup();
    rpc.mockResolvedValue({ data: [], error: null });
    const onProgress = vi.fn();
    expect(await api.loadMyBookAnnotations("book:one", "reader:a", { onProgress })).toEqual([]);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("get_my_book_annotations", {
      p_content_id: "book:one", p_after_id: null, p_limit: 100,
    }, "reader:a", expect.any(AbortSignal));
    expect(onProgress).toHaveBeenLastCalledWith({ notes: [], complete: true });
    expect(await api.loadMyBookAnnotations("book:one", "reader:a")).toEqual([]);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("paginates 101 notes by the final thread id and reports completion only on the final page", async () => {
    const { api, rpc } = setup();
    const firstPage = Array.from({ length: 100 }, (_, index) => thread(`note-${index}`));
    const last = thread("note-100");
    rpc.mockResolvedValueOnce({ data: firstPage, error: null }).mockResolvedValueOnce({ data: [last], error: null });
    const onProgress = vi.fn();
    expect(await api.loadMyBookAnnotations("book:one", "reader:a", { onProgress })).toEqual([...firstPage, last]);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[1]?.slice(0, 3)).toEqual(["get_my_book_annotations", {
      p_content_id: "book:one", p_after_id: "note-99", p_limit: 100,
    }, "reader:a"]);
    expect(rpc.mock.calls[1]?.[3]).toBe(rpc.mock.calls[0]?.[3]);
    expect(onProgress).toHaveBeenNthCalledWith(1, { notes: firstPage, complete: false });
    expect(onProgress).toHaveBeenLastCalledWith({ notes: [...firstPage, last], complete: true });
  });

  it("keeps partial results explicitly incomplete and retries from the first page after an error", async () => {
    const { api, rpc } = setup();
    const firstPage = Array.from({ length: 100 }, (_, index) => thread(`note-${index}`));
    const onProgress = vi.fn();
    rpc.mockResolvedValueOnce({ data: firstPage, error: null }).mockResolvedValueOnce({ data: null, error: { message: "读取失败" } });
    await expect(api.loadMyBookAnnotations("book:one", "reader:a", { onProgress })).rejects.toThrow("读取失败");
    expect(onProgress).toHaveBeenCalledExactlyOnceWith({ notes: firstPage, complete: false });
    rpc.mockResolvedValueOnce({ data: [thread("fresh")], error: null });
    expect(await api.loadMyBookAnnotations("book:one", "reader:a")).toEqual([thread("fresh")]);
    expect(rpc.mock.calls[2]?.[1]).toEqual({ p_content_id: "book:one", p_after_id: null, p_limit: 100 });
  });

  it("invalidates a cached empty book when the reader writes their first thought on another reader's mark", async () => {
    const { api, rpc } = setup();
    const shared = { ...thread("shared-mark", "reader:b"), underlinedByMe: false };
    const ownThought = { id: "my-first-thought", annotationId: shared.id, parentCommentId: null,
      authorId: "reader:a", authorName: "读者", body: "我的第一条想法", visibility: "private" as const,
      createdAt: "2026-09-12T00:00:00Z", reportedByMe: false };
    let written = false;
    rpc.mockImplementation(async (name) => {
      if (name === "get_my_book_annotations") return { data: written ? [{ ...shared, comments: [ownThought] }] : [], error: null };
      if (name === "get_annotation_threads") return { data: [shared], error: null };
      written = true;
      return { data: ownThought, error: null };
    });
    expect(await api.loadMyBookAnnotations("book:one", "reader:a")).toEqual([]);
    await api.loadAnnotationThreads(subject, "reader:a");
    await api.addAnnotationComment(shared.id, ownThought.body, undefined, "private", "reader:a");
    expect(await api.loadMyBookAnnotations("book:one", "reader:a")).toEqual([{ ...shared, comments: [ownThought] }]);
    expect(rpc.mock.calls.filter(([name]) => name === "get_my_book_annotations")).toHaveLength(2);
  });

  it("times out the entire read after 15 seconds and never caches its late response", async () => {
    vi.useFakeTimers();
    const { api, rpc } = setup();
    const first = deferred<RpcResult>();
    const stalled = deferred<RpcResult>();
    rpc.mockReturnValueOnce(first.promise).mockReturnValueOnce(stalled.promise);
    const firstPage = Array.from({ length: 100 }, (_, index) => thread(`note-${index}`));
    const onProgress = vi.fn();
    const loading = api.loadMyBookAnnotations("book:one", "reader:a", { onProgress });
    const rejected = expect(loading).rejects.toThrow(/超时/);
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(10_000);
    first.resolve({ data: firstPage, error: null });
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(rpc.mock.calls[1]?.[3]?.aborted).toBe(true);
    expect(onProgress).toHaveBeenCalledExactlyOnceWith({ notes: firstPage, complete: false });
    rpc.mockResolvedValueOnce({ data: [thread("reopened")], error: null });
    expect(await api.loadMyBookAnnotations("book:one", "reader:a")).toEqual([thread("reopened")]);
    stalled.resolve({ data: [thread("late")], error: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(await api.loadMyBookAnnotations("book:one", "reader:a")).toEqual([thread("reopened")]);
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it("stops before the next page if the account changes after partial progress", async () => {
    const { api, rpc, getCurrentUserId } = setup();
    rpc.mockResolvedValue({ data: Array.from({ length: 100 }, (_, index) => thread(`a-${index}`)), error: null });
    const onProgress = vi.fn(() => { getCurrentUserId.mockResolvedValue("reader:b"); });

    await expect(api.loadMyBookAnnotations("book:one", "reader:a", { onProgress }))
      .rejects.toThrow("登录状态已变化");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it("does not make authenticated read or write calls after sign-out", async () => {
    const { api, rpc, getCurrentUserId } = setup();
    getCurrentUserId.mockResolvedValue(null);
    await expect(api.loadAnnotationThreads(subject)).rejects.toThrow("请先登录");
    await expect(api.createAnnotation(subject, anchor)).rejects.toThrow("请先登录");
    await expect(api.addAnnotationComment("one", "回复")).rejects.toThrow("请先登录");
    await expect(api.reportAnnotationComment("comment", "other")).rejects.toThrow("请先登录");
    await expect(api.setAnnotationCommentLike("comment", true)).rejects.toThrow("请先登录");
    await expect(api.deleteMyAnnotationMark("one")).rejects.toThrow("请先登录");
    expect(await api.loadMyBookAnnotations("book:one", null)).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects the caller's stale identity before any read or write transport", async () => {
    const { api, rpc, getCurrentUserId } = setup();
    getCurrentUserId.mockResolvedValue("reader:b");
    await expect(api.createAnnotation(subject, anchor, "旧草稿", "private", "reader:a")).rejects.toThrow("登录状态已变化");
    await expect(api.addAnnotationComment("one", "旧回复", undefined, "private", "reader:a")).rejects.toThrow("登录状态已变化");
    await expect(api.reportAnnotationComment("comment", "spam", undefined, "reader:a")).rejects.toThrow("登录状态已变化");
    await expect(api.loadAnnotationThreads(subject, "reader:a")).rejects.toThrow("登录状态已变化");
    await expect(api.setAnnotationCommentLike("comment", true, "reader:a")).rejects.toThrow("登录状态已变化");
    await expect(api.deleteMyAnnotationMark("one", "reader:a")).rejects.toThrow("登录状态已变化");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("passes the captured identity to every authenticated transport", async () => {
    const { api, rpc } = setup();
    await api.createAnnotation(subject, anchor);
    await api.addAnnotationComment("one", "回复");
    await api.reportAnnotationComment("comment", "spam");
    rpc.mockResolvedValue({ data: [], error: null });
    await api.loadAnnotationThreads(subject);
    await api.loadMyBookAnnotations("book:one", "reader:a");
    expect(rpc).toHaveBeenCalledTimes(5);
    expect(rpc.mock.calls.every(([, , expectedUserId]) => expectedUserId === "reader:a")).toBe(true);
  });
});
