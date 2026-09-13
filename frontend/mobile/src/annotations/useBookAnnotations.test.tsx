import { StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnnotationComment, AnnotationSubject, AnnotationThread, BookAnnotationOptions, TextAnchor } from "@jojo/content/annotations";
import { useBookAnnotations } from "./useBookAnnotations";

const api = vi.hoisted(() => ({
  loadAnnotationThreads: vi.fn(), loadMyBookAnnotations: vi.fn(), createAnnotation: vi.fn(),
  addAnnotationComment: vi.fn(), reportAnnotationComment: vi.fn(), deleteMyAnnotationMark: vi.fn(),
}));
vi.mock("./api", () => api);

const subject: AnnotationSubject = { contentType: "book", contentId: "book", sectionId: "c1", contentTitle: "示例书" };
const anchor: TextAnchor = { quote: "示例正文", prefix: "前文", suffix: "后文", startOffset: 2, endOffset: 6 };
function comment(id: string, authorId = "reader:a", overrides: Partial<AnnotationComment> = {}): AnnotationComment {
  return {
    id, annotationId: "thread", parentCommentId: null, authorId, authorName: authorId, body: id,
    visibility: "public", createdAt: "2026-09-12T00:00:00Z", reportedByMe: false, ...overrides,
  };
}
function thread(id: string, overrides: Partial<AnnotationThread> = {}): AnnotationThread {
  return {
    ...subject, ...anchor, id, authorId: "reader:other", authorName: "其他读者",
    createdAt: "2026-09-12T00:00:00Z", underlinedByMe: false, comments: [], ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

type Options = Parameters<typeof useBookAnnotations>[0];
const defaults: Options = { userId: "reader:a", contentId: "book", activeSectionId: "c1", loadAll: false };
let state: ReturnType<typeof useBookAnnotations>;
let view: ReactTestRenderer | undefined;
let options: Options;
let strict = false;
function Harness({ value }: { value: Options }) { state = useBookAnnotations(value); return null; }
function element() { return strict ? <StrictMode><Harness value={options} /></StrictMode> : <Harness value={options} />; }
async function mount(overrides: Partial<Options> = {}, strictMode = false) {
  options = { ...defaults, ...overrides };
  strict = strictMode;
  await act(async () => { view = create(element()); });
}
async function rerender(overrides: Partial<Options>) {
  options = { ...options, ...overrides };
  await act(async () => view!.update(element()));
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  api.loadAnnotationThreads.mockReset().mockResolvedValue([]);
  api.loadMyBookAnnotations.mockReset().mockResolvedValue([]);
  api.createAnnotation.mockReset().mockResolvedValue(thread("created", { underlinedByMe: true }));
  api.addAnnotationComment.mockReset().mockResolvedValue(comment("created-comment"));
  api.reportAnnotationComment.mockReset().mockResolvedValue(undefined);
  api.deleteMyAnnotationMark.mockReset().mockResolvedValue(null);
});
afterEach(async () => {
  await act(async () => view?.unmount());
  view = undefined;
});

describe("native cloud book annotations", () => {
  it("keeps complete active-chapter discussions while counting only the reader's underlines and comments", async () => {
    const mine = comment("my-public");
    const privateMine = comment("my-private", "reader:a", { visibility: "private" });
    const other = comment("other-public", "reader:other");
    const shared = thread("shared", { comments: [mine, privateMine, other] });
    const remote = thread("remote-underline", { sectionId: "c2", underlinedByMe: true, comments: [other] });
    api.loadAnnotationThreads.mockResolvedValue([
      shared,
      thread("other-only", { comments: [other] }),
      thread("legacy-own", { authorId: "reader:a", underlinedByMe: undefined }),
      thread("former-author", { authorId: "reader:a", underlinedByMe: false }),
    ]);
    api.loadMyBookAnnotations.mockResolvedValue([remote, { ...shared, comments: [mine, privateMine] }, thread("legacy-own", { authorId: "reader:a", underlinedByMe: undefined })]);

    await mount({ loadAll: true });

    expect(state.threads.find((entry) => entry.id === "shared")?.comments).toEqual([mine, privateMine, other]);
    expect(state.threads.map((entry) => entry.id)).toContain("other-only");
    expect(state.notes.map((entry) => entry.id).sort()).toEqual(["legacy-own", "remote-underline", "shared"]);
    expect(state.notes.find((entry) => entry.id === "shared")?.comments).toEqual([mine, privateMine]);
    expect(state.notes.find((entry) => entry.id === "remote-underline")?.comments).toEqual([]);
    expect(state.loading).toBe(false);
  });

  it("hides the previous account immediately and ignores its late responses and progress", async () => {
    const oldDiscussion = deferred<AnnotationThread[]>();
    const newDiscussion = deferred<AnnotationThread[]>();
    const oldPersonal = deferred<AnnotationThread[]>();
    const newPersonal = deferred<AnnotationThread[]>();
    api.loadAnnotationThreads.mockReturnValueOnce(oldDiscussion.promise).mockReturnValueOnce(newDiscussion.promise);
    api.loadMyBookAnnotations.mockReturnValueOnce(oldPersonal.promise).mockReturnValueOnce(newPersonal.promise);
    await mount({ loadAll: true });
    const oldOptions = api.loadMyBookAnnotations.mock.calls[0]![2] as BookAnnotationOptions;
    await act(async () => oldOptions.onProgress!({ notes: [thread("a-private", { underlinedByMe: true })], complete: false }));
    expect(state.notes.map((entry) => entry.id)).toEqual(["a-private"]);

    await rerender({ userId: "reader:b" });

    expect(state.threads).toEqual([]);
    expect(state.notes).toEqual([]);
    expect(oldOptions.signal?.aborted).toBe(true);
    await act(async () => {
      oldOptions.onProgress!({ notes: [thread("a-late", { underlinedByMe: true })], complete: true });
      oldDiscussion.resolve([thread("a-discussion")]);
      oldPersonal.resolve([thread("a-private", { underlinedByMe: true })]);
    });
    expect(state.threads).toEqual([]);
    expect(state.notes).toEqual([]);
    await act(async () => {
      newDiscussion.resolve([thread("b-discussion")]);
      newPersonal.resolve([thread("b-private", { underlinedByMe: true })]);
    });
    expect(state.threads.map((entry) => entry.id).sort()).toEqual(["b-discussion", "b-private"]);
    expect(state.notes.map((entry) => entry.id)).toEqual(["b-private"]);
  });

  it("rejects saved action callbacks after switching readers without submitting any old action", async () => {
    await mount();
    const previousActions = state;
    await rerender({ userId: "reader:b" });
    const discussionCalls = api.loadAnnotationThreads.mock.calls.length;

    await expect(previousActions.create(subject, anchor, "旧想法", "private")).rejects.toThrow("登录状态已变化");
    await expect(previousActions.comment(thread("old"), "旧回复")).rejects.toThrow("登录状态已变化");
    await expect(previousActions.report(thread("old"), "comment", "spam")).rejects.toThrow("登录状态已变化");
    await expect(previousActions.open(thread("old"))).rejects.toThrow("登录状态已变化");
    await expect(previousActions.removeMark(thread("old", { underlinedByMe: true }))).rejects.toThrow("登录状态已变化");
    expect(api.createAnnotation).not.toHaveBeenCalled();
    expect(api.addAnnotationComment).not.toHaveBeenCalled();
    expect(api.reportAnnotationComment).not.toHaveBeenCalled();
    expect(api.deleteMyAnnotationMark).not.toHaveBeenCalled();
    expect(api.loadAnnotationThreads).toHaveBeenCalledTimes(discussionCalls);
  });

  it("does not merge a completed old-account write into the new reader's notes", async () => {
    const pending = deferred<AnnotationThread>();
    api.createAnnotation.mockReturnValueOnce(pending.promise);
    await mount();
    let creating!: Promise<AnnotationThread>;
    await act(async () => { creating = state.create(subject, anchor, "旧账号私密内容", "private"); });
    const rejected = expect(creating).rejects.toThrow("登录状态已变化");
    await rerender({ userId: "reader:b" });

    await act(async () => pending.resolve(thread("old-account", { underlinedByMe: true })));

    await rejected;
    expect(state.notes).toEqual([]);
    expect(state.threads).toEqual([]);
  });

  it("merges successful private creates by annotation id immediately", async () => {
    api.loadAnnotationThreads.mockResolvedValue([thread("existing")]);
    const saved = thread("existing", { comments: [comment("private-thought", "reader:a", { visibility: "private" })] });
    api.createAnnotation.mockResolvedValue(saved);
    await mount();

    await act(async () => { await state.create(subject, anchor, "私密想法", "private"); });
    await act(async () => { await state.create(subject, anchor); });

    expect(api.createAnnotation).toHaveBeenNthCalledWith(1, subject, anchor, "私密想法", "private", "reader:a");
    expect(state.threads).toHaveLength(1);
    expect(state.threads[0]).toMatchObject({ id: "existing", underlinedByMe: true, comments: saved.comments });
    expect(state.notes).toHaveLength(1);
  });

  it("merges private replies and replaces duplicate returned comment ids", async () => {
    const existing = thread("thread", { comments: [comment("other", "reader:other")] });
    api.loadAnnotationThreads.mockResolvedValue([existing]);
    const saved = comment("reply", "reader:a", { visibility: "private", body: "私密回复" });
    api.addAnnotationComment.mockResolvedValueOnce(saved).mockResolvedValueOnce({ ...saved, body: "更新的私密回复" });
    await mount();

    await act(async () => { await state.comment(existing, "私密回复", "parent", "private"); });
    await act(async () => { await state.comment(existing, "更新的私密回复", "parent", "private"); });

    expect(api.addAnnotationComment).toHaveBeenNthCalledWith(1, "thread", "私密回复", "parent", "private", "reader:a");
    expect(state.threads).toHaveLength(1);
    expect(state.threads[0]?.comments.map((entry) => entry.id)).toEqual(["other", "reply"]);
    expect(state.notes[0]?.comments).toEqual([{ ...saved, body: "更新的私密回复" }]);
  });

  it("shows a sanitized load error and retries both full-book notes and the current discussion", async () => {
    api.loadAnnotationThreads.mockRejectedValueOnce(new Error("SQL SELECT private.annotation_records failed"));
    api.loadMyBookAnnotations.mockRejectedValueOnce(new Error("SQL SELECT private.annotation_records failed"));
    await mount({ loadAll: true });
    expect(state.error).toBe("想法暂时无法保存或读取，请重试");
    expect(state.loading).toBe(false);
    api.loadAnnotationThreads.mockResolvedValue([thread("retried", { underlinedByMe: true })]);
    api.loadMyBookAnnotations.mockResolvedValue([thread("retried", { underlinedByMe: true })]);

    await act(async () => state.refresh());

    expect(state.error).toBe("");
    expect(state.notes.map((entry) => entry.id)).toEqual(["retried"]);
    expect(api.loadAnnotationThreads).toHaveBeenCalledTimes(2);
    expect(api.loadMyBookAnnotations).toHaveBeenCalledTimes(2);
    expect(api.loadMyBookAnnotations.mock.calls[1]![2]).toHaveProperty("refresh", true);
  });

  it("ignores cleanup-aborted effects while StrictMode's replacement requests populate notes", async () => {
    const discussions: Array<ReturnType<typeof deferred<AnnotationThread[]>>> = [];
    const personal: Array<ReturnType<typeof deferred<AnnotationThread[]>>> = [];
    api.loadAnnotationThreads.mockImplementation(() => { const request = deferred<AnnotationThread[]>(); discussions.push(request); return request.promise; });
    api.loadMyBookAnnotations.mockImplementation(() => { const request = deferred<AnnotationThread[]>(); personal.push(request); return request.promise; });
    await mount({ loadAll: true }, true);
    expect(discussions).toHaveLength(2);
    expect(personal).toHaveLength(2);
    const oldOptions = api.loadMyBookAnnotations.mock.calls[0]![2] as BookAnnotationOptions;
    expect(oldOptions.signal?.aborted).toBe(true);

    await act(async () => {
      discussions[1]!.resolve([thread("current-discussion")]);
      personal[1]!.resolve([thread("current-own", { underlinedByMe: true })]);
    });
    await act(async () => {
      oldOptions.onProgress!({ notes: [thread("stale-private", { underlinedByMe: true })], complete: false });
      discussions[0]!.resolve([thread("stale-discussion")]);
      personal[0]!.resolve([thread("stale-private", { underlinedByMe: true })]);
    });

    expect(state.threads.map((entry) => entry.id).sort()).toEqual(["current-discussion", "current-own"]);
    expect(state.notes.map((entry) => entry.id)).toEqual(["current-own"]);
    expect(state.loading).toBe(false);
  });

  it("does not let old chapter and personal-note reads overwrite a newly saved annotation", async () => {
    const discussion = deferred<AnnotationThread[]>();
    const personal = deferred<AnnotationThread[]>();
    api.loadAnnotationThreads.mockReturnValueOnce(discussion.promise);
    api.loadMyBookAnnotations.mockReturnValueOnce(personal.promise);
    await mount({ loadAll: true });
    const readOptions = api.loadMyBookAnnotations.mock.calls[0]![2] as BookAnnotationOptions;
    const saved = thread("created", { underlinedByMe: true, comments: [comment("new-private", "reader:a", { visibility: "private" })] });
    api.createAnnotation.mockResolvedValue(saved);
    api.loadMyBookAnnotations.mockResolvedValue([saved]);
    await act(async () => { await state.create(subject, anchor, "私密想法", "private"); });

    await act(async () => {
      readOptions.onProgress!({ notes: [thread("created")], complete: false });
      discussion.resolve([thread("created")]);
      personal.resolve([thread("created")]);
    });

    expect(state.notes).toEqual([saved]);
    expect(state.threads).toEqual([saved]);
  });

  it("does not surface obsolete read failures after a successful write", async () => {
    const discussion = deferred<AnnotationThread[]>();
    const personal = deferred<AnnotationThread[]>();
    api.loadAnnotationThreads.mockReturnValueOnce(discussion.promise);
    api.loadMyBookAnnotations.mockReturnValueOnce(personal.promise);
    await mount({ loadAll: true });
    api.loadMyBookAnnotations.mockResolvedValue([thread("created", { underlinedByMe: true })]);
    await act(async () => { await state.create(subject, anchor); });

    await act(async () => {
      discussion.reject(new Error("old network failure"));
      personal.reject(new Error("old network failure"));
    });

    expect(state.error).toBe("");
    expect(state.notes.map((entry) => entry.id)).toEqual(["created"]);
  });

  it("preserves a newly saved comment when an earlier report request finishes later", async () => {
    const existing = thread("thread", { comments: [comment("reported", "reader:other")] });
    api.loadAnnotationThreads.mockResolvedValue([existing]);
    const pendingReport = deferred<void>();
    api.reportAnnotationComment.mockReturnValueOnce(pendingReport.promise);
    await mount();
    let reporting!: Promise<void>;
    await act(async () => { reporting = state.report(existing, "reported", "spam"); });
    await act(async () => { await state.comment(existing, "自己的回复"); });
    await act(async () => { pendingReport.resolve(); await reporting; });

    expect(state.threads[0]?.comments.map((entry) => entry.id)).toEqual(["reported", "created-comment"]);
    expect(state.threads[0]?.comments[0]?.reportedByMe).toBe(true);
    expect(state.notes[0]?.comments.map((entry) => entry.id)).toEqual(["created-comment"]);
  });

  it("clears visible notes on sign-out and makes no signed-out requests", async () => {
    api.loadAnnotationThreads.mockResolvedValue([thread("own", { underlinedByMe: true })]);
    api.loadMyBookAnnotations.mockResolvedValue([thread("own", { underlinedByMe: true })]);
    await mount({ loadAll: true });
    expect(state.notes).toHaveLength(1);
    const calls = api.loadAnnotationThreads.mock.calls.length;
    const personalCalls = api.loadMyBookAnnotations.mock.calls.length;

    await rerender({ userId: null });

    expect(state.notes).toEqual([]);
    expect(state.threads).toEqual([]);
    expect(api.loadAnnotationThreads).toHaveBeenCalledTimes(calls);
    expect(api.loadMyBookAnnotations).toHaveBeenCalledTimes(personalCalls);
    await expect(state.create(subject, anchor)).rejects.toThrow("登录状态已变化");
    expect(api.createAnnotation).not.toHaveBeenCalled();
  });

  it("refreshes the reader's comments in previously visited chapters without losing public discussion order", async () => {
    const firstPublic = comment("first-public", "reader:other");
    const oldMine = comment("existing-own", "reader:a", { body: "旧内容", visibility: "private" });
    const removedMine = comment("removed-own");
    const lastPublic = comment("last-public", "reader:other");
    const oldThread = thread("visited", { underlinedByMe: true, comments: [firstPublic, oldMine, lastPublic, removedMine] });
    api.loadAnnotationThreads.mockResolvedValueOnce([oldThread]).mockResolvedValue([]);
    await mount();
    const updatedMine = { ...oldMine, body: "另一设备更新后的私密想法" };
    const newMine = comment("new-own", "reader:a", { visibility: "private" });
    api.loadMyBookAnnotations.mockResolvedValue([{
      ...oldThread, underlinedByMe: false, comments: [updatedMine, newMine],
    }]);

    await rerender({ activeSectionId: "c2", loadAll: true });

    expect(state.threads.find((entry) => entry.id === "visited")?.comments)
      .toEqual([firstPublic, updatedMine, lastPublic, newMine]);
    expect(state.notes.find((entry) => entry.id === "visited"))
      .toMatchObject({ underlinedByMe: false, comments: [updatedMine, newMine] });
    expect(api.loadAnnotationThreads).toHaveBeenCalledTimes(2);
  });

  it.each(["create", "comment"] as const)("restarts interrupted full-book reads after %s without reloading the current discussion", async (operation) => {
    const initial = thread("thread", { underlinedByMe: true });
    api.loadAnnotationThreads.mockResolvedValue([initial]);
    const oldPersonal = deferred<AnnotationThread[]>();
    const freshPersonal = deferred<AnnotationThread[]>();
    api.loadMyBookAnnotations.mockReturnValueOnce(oldPersonal.promise).mockReturnValueOnce(freshPersonal.promise);
    await mount({ loadAll: true });
    const oldOptions = api.loadMyBookAnnotations.mock.calls[0]![2] as BookAnnotationOptions;
    const savedComment = comment("written-own", "reader:a", { visibility: "private" });
    const saved = { ...initial, comments: [savedComment] };
    api.createAnnotation.mockResolvedValue(saved);
    api.addAnnotationComment.mockResolvedValue(savedComment);

    await act(async () => {
      if (operation === "create") await state.create(subject, anchor, "自己的想法", "private");
      else await state.comment(initial, "自己的回复", undefined, "private");
    });

    expect(api.loadMyBookAnnotations).toHaveBeenCalledTimes(2);
    expect(oldOptions.signal?.aborted).toBe(true);
    expect(api.loadAnnotationThreads).toHaveBeenCalledTimes(1);
    expect(state.loading).toBe(true);
    const otherChapterNote = thread("other-chapter", { sectionId: "c2", underlinedByMe: true });
    await act(async () => freshPersonal.resolve([saved, otherChapterNote]));
    await act(async () => {
      oldOptions.onProgress!({ notes: [initial], complete: false });
      oldPersonal.resolve([initial]);
    });

    expect(state.notes.map((entry) => entry.id).sort()).toEqual(["other-chapter", "thread"]);
    expect(state.notes.find((entry) => entry.id === "thread")?.comments).toEqual([savedComment]);
    expect(state.loading).toBe(false);
    expect(api.loadAnnotationThreads).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending book read when closed and allows an empty reopened read to finish", async () => {
    const old = deferred<AnnotationThread[]>();
    api.loadMyBookAnnotations.mockReturnValueOnce(old.promise).mockResolvedValue([]);
    await mount({ loadAll: true });
    const previous = api.loadMyBookAnnotations.mock.calls[0]![2] as BookAnnotationOptions;
    expect(state.loading).toBe(true);
    await rerender({ loadAll: false });
    expect(previous.signal?.aborted).toBe(true);
    expect(state.loading).toBe(false);
    await rerender({ loadAll: true });
    expect(state.loading).toBe(false);
    expect(state.notes).toEqual([]);
    expect(api.loadMyBookAnnotations.mock.calls[1]?.slice(0, 2)).toEqual(["book", "reader:a"]);
    await act(async () => old.resolve([thread("obsolete", { underlinedByMe: true })]));
    expect(state.notes).toEqual([]);
  });

  it("stops the spinner on timeout and retries with a fresh whole-book read", async () => {
    api.loadMyBookAnnotations.mockRejectedValueOnce(new Error("笔记读取超时，请检查网络后重试"));
    await mount({ loadAll: true });
    expect(state.loading).toBe(false);
    expect(state.error).toBe("笔记读取超时，请检查网络后重试");
    await act(async () => state.refresh());
    expect(state.loading).toBe(false);
    expect(state.error).toBe("");
    expect(state.notes).toEqual([]);
  });

  it("clears an underline removed elsewhere after a complete empty personal read", async () => {
    api.loadAnnotationThreads.mockResolvedValue([thread("old-own", { underlinedByMe: true })]);
    await mount();
    expect(state.notes).toHaveLength(1);
    await rerender({ loadAll: true });
    expect(state.notes).toEqual([]);
  });

  it("deletes only the personal underline while preserving private thoughts when the discussion is no longer public", async () => {
    const mine = comment("private", "reader:a", { visibility: "private" });
    const own = thread("own", { underlinedByMe: true, comments: [mine] });
    api.loadAnnotationThreads.mockResolvedValue([own]);
    await mount();
    await act(async () => { await state.removeMark(own); });
    expect(api.deleteMyAnnotationMark).toHaveBeenCalledExactlyOnceWith("own", "reader:a");
    expect(state.notes).toEqual([{ ...own, underlinedByMe: false, publiclyVisible: false, comments: [mine] }]);
    expect(state.threads[0]?.underlinedByMe).toBe(false);
  });

  it("preserves other readers' marks and comments after deleting an own mark", async () => {
    const other = comment("public", "reader:other");
    const own = thread("shared", { underlinedByMe: true, publiclyVisible: true, comments: [other], underlineCount: 8 });
    const changed = { ...own, underlinedByMe: false, underlineCount: 7 };
    api.loadAnnotationThreads.mockResolvedValue([own]);
    api.deleteMyAnnotationMark.mockResolvedValue(changed);
    await mount();
    await act(async () => { await state.removeMark(own); });
    expect(state.threads).toEqual([changed]);
    expect(state.notes).toEqual([]);
    await expect(state.removeMark(changed)).rejects.toThrow("只能删除自己的划线");
    expect(api.deleteMyAnnotationMark).toHaveBeenCalledOnce();
  });

  it("coalesces repeated deletion taps, preserves the mark on failure and allows retry", async () => {
    const own = thread("own", { underlinedByMe: true });
    api.loadAnnotationThreads.mockResolvedValue([own]);
    const pending = deferred<AnnotationThread | null>();
    api.deleteMyAnnotationMark.mockReturnValueOnce(pending.promise).mockResolvedValue(null);
    await mount();
    let first!: Promise<AnnotationThread | null>, second!: Promise<AnnotationThread | null>;
    await act(async () => { first = state.removeMark(own); second = state.removeMark(own); });
    const firstError = expect(first).rejects.toThrow("network");
    const secondError = expect(second).rejects.toThrow("network");
    expect(api.deleteMyAnnotationMark).toHaveBeenCalledOnce();
    await act(async () => pending.reject(new Error("network")));
    await firstError; await secondError;
    expect(state.notes).toEqual([own]);
    await act(async () => { await state.removeMark(own); });
    expect(state.notes).toEqual([]);
    expect(api.deleteMyAnnotationMark).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("queues a new thought behind deletion without restoring the mark (public discussion: %s)", async (publiclyVisible) => {
    const own = thread("own", { underlinedByMe: true, publiclyVisible: true });
    const pending = deferred<AnnotationThread | null>();
    const saved = comment("new-private", "reader:a", { annotationId: own.id, visibility: "private" });
    api.loadAnnotationThreads.mockResolvedValue([own]);
    api.deleteMyAnnotationMark.mockReturnValueOnce(pending.promise);
    api.addAnnotationComment.mockResolvedValue(saved);
    await mount();
    let deleting!: Promise<AnnotationThread | null>, commenting!: Promise<AnnotationComment>;
    await act(async () => {
      deleting = state.removeMark(own);
      commenting = state.comment(own, saved.body, undefined, "private");
    });
    expect(api.deleteMyAnnotationMark).toHaveBeenCalledOnce();
    expect(api.addAnnotationComment).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve(publiclyVisible ? { ...own, underlinedByMe: false } : null);
      await deleting;
      await commenting;
    });

    expect(api.addAnnotationComment).toHaveBeenCalledExactlyOnceWith("own", saved.body, undefined, "private", "reader:a");
    expect(state.notes).toEqual([{ ...own, underlinedByMe: false, publiclyVisible, comments: [saved] }]);
    expect(state.threads).toEqual(state.notes);
    expect(api.loadAnnotationThreads).toHaveBeenCalledOnce();
  });

  it("queues recreating a mark behind deletion and keeps the newly created mark", async () => {
    const own = thread("own", { underlinedByMe: true });
    const pending = deferred<AnnotationThread | null>();
    const saved = { ...own, comments: [comment("new-thought")] };
    api.loadAnnotationThreads.mockResolvedValue([own]);
    api.deleteMyAnnotationMark.mockReturnValueOnce(pending.promise);
    api.createAnnotation.mockResolvedValue(saved);
    await mount();
    let deleting!: Promise<AnnotationThread | null>, creating!: Promise<AnnotationThread>;
    await act(async () => {
      deleting = state.removeMark(own);
      creating = state.create(subject, anchor, "new-thought");
    });
    expect(api.createAnnotation).not.toHaveBeenCalled();

    await act(async () => { pending.resolve(null); await deleting; await creating; });

    expect(state.notes).toEqual([saved]);
    expect(state.threads).toEqual([saved]);
    expect(api.createAnnotation).toHaveBeenCalledOnce();
  });

  it("finishes a pending thought before deleting the mark and preserves the thought", async () => {
    const own = thread("own", { underlinedByMe: true, publiclyVisible: true });
    const pending = deferred<AnnotationComment>();
    const saved = comment("kept-private", "reader:a", { annotationId: own.id, visibility: "private" });
    api.loadAnnotationThreads.mockResolvedValue([own]);
    api.addAnnotationComment.mockReturnValueOnce(pending.promise);
    await mount();
    let deleting!: Promise<AnnotationThread | null>, commenting!: Promise<AnnotationComment>;
    await act(async () => {
      commenting = state.comment(own, saved.body, undefined, "private");
      deleting = state.removeMark(own);
    });
    expect(api.addAnnotationComment).toHaveBeenCalledOnce();
    expect(api.deleteMyAnnotationMark).not.toHaveBeenCalled();

    await act(async () => { pending.resolve(saved); await commenting; await deleting; });

    expect(state.notes).toEqual([{ ...own, underlinedByMe: false, publiclyVisible: false, comments: [saved] }]);
    expect(state.threads).toEqual(state.notes);
    expect(api.deleteMyAnnotationMark).toHaveBeenCalledOnce();
  });

  it("runs the queued thought after a failed deletion while retaining the mark", async () => {
    const own = thread("own", { underlinedByMe: true });
    const pending = deferred<AnnotationThread | null>();
    api.loadAnnotationThreads.mockResolvedValue([own]);
    api.deleteMyAnnotationMark.mockReturnValueOnce(pending.promise);
    await mount();
    let deleting!: Promise<AnnotationThread | null>, commenting!: Promise<AnnotationComment>;
    await act(async () => {
      deleting = state.removeMark(own);
      commenting = state.comment(own, "kept-thought");
    });
    const rejected = expect(deleting).rejects.toThrow("network");
    expect(api.addAnnotationComment).not.toHaveBeenCalled();

    await act(async () => { pending.reject(new Error("network")); await rejected; await commenting; });

    expect(state.notes[0]).toMatchObject({ id: "own", underlinedByMe: true, comments: [comment("created-comment")] });
    expect(api.addAnnotationComment).toHaveBeenCalledOnce();
  });

  it.each(["reader:b", "reader:a"])("never submits queued old-account actions after switching readers (current: %s)", async (nextReader) => {
    const own = thread("own", { underlinedByMe: true });
    const pending = deferred<AnnotationThread | null>();
    api.deleteMyAnnotationMark.mockReturnValueOnce(pending.promise);
    await mount();
    let deleting!: Promise<AnnotationThread | null>, commenting!: Promise<AnnotationComment>, creating!: Promise<AnnotationThread>;
    await act(async () => {
      deleting = state.removeMark(own);
      commenting = state.comment(own, "old-account-thought");
      creating = state.create(subject, anchor);
    });
    const rejected = [deleting, commenting, creating].map((request) => expect(request).rejects.toThrow("登录状态已变化"));
    await rerender({ userId: "reader:b" });
    if (nextReader === "reader:a") await rerender({ userId: "reader:a" });
    // The current reader can write without waiting for the obsolete queue.
    await act(async () => { await state.create(subject, anchor, "current-account-thought"); });
    await act(async () => { pending.resolve(null); await Promise.all(rejected); });

    expect(api.addAnnotationComment).not.toHaveBeenCalled();
    expect(api.createAnnotation).toHaveBeenCalledExactlyOnceWith(subject, anchor, "current-account-thought", "public", nextReader);
    expect(state.notes.map((entry) => entry.id)).toEqual(["created"]);
  });

  it("ignores a deletion finishing after an account change", async () => {
    const pending = deferred<AnnotationThread | null>();
    api.deleteMyAnnotationMark.mockReturnValueOnce(pending.promise);
    await mount();
    let deleting!: Promise<AnnotationThread | null>;
    await act(async () => { deleting = state.removeMark(thread("old", { underlinedByMe: true })); });
    const rejected = expect(deleting).rejects.toThrow("登录状态已变化");
    await rerender({ userId: "reader:b" });
    await act(async () => pending.resolve(null));
    await rejected;
    expect(state.notes).toEqual([]);
  });
});
