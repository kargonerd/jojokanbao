import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAnnotationThreads } from "../src/annotations/useAnnotationThreads";
import type { AnnotationSubject, AnnotationThread } from "../src/annotations/types";

const annotationApi = vi.hoisted(() => ({
  loadAnnotationThreads: vi.fn(),
  createAnnotation: vi.fn(),
  addAnnotationComment: vi.fn(),
  reportAnnotationComment: vi.fn(),
}));

vi.mock("../src/annotations/api", () => annotationApi);

function subject(sectionId: string): AnnotationSubject {
  return {
    contentType: "book",
    contentId: "book-1",
    sectionId,
    contentTitle: `测试书 · ${sectionId}`,
  };
}

function thread(sectionId: string): AnnotationThread {
  return {
    ...subject(sectionId),
    id: `annotation-${sectionId}`,
    authorId: "user-1",
    authorName: "读者-ABC",
    quote: sectionId,
    prefix: "",
    suffix: "",
    startOffset: 0,
    endOffset: sectionId.length,
    createdAt: "2026-08-18T10:00:00Z",
    comments: [],
  };
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("useAnnotationThreads", () => {
  it("pins reads, thoughts, replies, and reports to the current account", async () => {
    const entry = thread("chapter-1");
    const comment = { id: "comment-1", annotationId: entry.id, parentCommentId: null, authorId: "user-1", authorName: "读者", body: "私密想法", visibility: "private" as const, createdAt: entry.createdAt, reportedByMe: false };
    annotationApi.loadAnnotationThreads.mockResolvedValue([entry]);
    annotationApi.createAnnotation.mockResolvedValue(entry);
    annotationApi.addAnnotationComment.mockResolvedValue(comment);
    annotationApi.reportAnnotationComment.mockResolvedValue(undefined);
    const { result } = renderHook(() => useAnnotationThreads(subject("chapter-1"), true, "user-1"));
    await waitFor(() => expect(result.current.threads).toHaveLength(1));
    expect(annotationApi.loadAnnotationThreads).toHaveBeenCalledWith(subject("chapter-1"), "user-1");

    await act(async () => { await result.current.create(entry, "私密想法", "private"); });
    expect(annotationApi.createAnnotation).toHaveBeenCalledWith(subject("chapter-1"), entry, "私密想法", "private", "user-1");
    await act(async () => { await result.current.comment(entry.id, "私密想法", "parent-1", "private"); });
    expect(annotationApi.addAnnotationComment).toHaveBeenCalledWith(entry.id, "私密想法", "parent-1", "private", "user-1");
    await act(async () => { await result.current.report(entry.id, comment.id, "spam", "说明"); });
    expect(annotationApi.reportAnnotationComment).toHaveBeenCalledWith(comment.id, "spam", "说明", "user-1");
    expect(result.current.threads[0]?.comments[0]?.reportedByMe).toBe(true);
  });

  it("hides previous private threads on the first account-switch render and rejects stale actions", async () => {
    const firstEntry = thread("chapter-1");
    const secondEntry = { ...firstEntry, id: "second-account", authorId: "user-2" };
    let resolveSecond!: (value: AnnotationThread[]) => void;
    let resolveWrite!: (value: AnnotationThread) => void;
    const second = new Promise<AnnotationThread[]>((resolve) => { resolveSecond = resolve; });
    annotationApi.loadAnnotationThreads.mockImplementation((_subject: AnnotationSubject, userId: string) => userId === "user-1" ? Promise.resolve([firstEntry]) : second);
    annotationApi.createAnnotation.mockImplementation(() => new Promise<AnnotationThread>((resolve) => { resolveWrite = resolve; }));
    const frames: Array<{ userId: string; ids: string[] }> = [];
    const { result, rerender } = renderHook(({ userId }) => {
      const annotations = useAnnotationThreads(subject("chapter-1"), true, userId);
      frames.push({ userId, ids: annotations.threads.map((entry) => entry.id) });
      return annotations;
    }, { initialProps: { userId: "user-1" } });
    await waitFor(() => expect(result.current.threads).toHaveLength(1));
    const previousActions = result.current;
    const pendingWrite = previousActions.create(firstEntry).catch((reason: unknown) => reason);
    rerender({ userId: "user-2" });
    expect(frames.filter((frame) => frame.userId === "user-2").every((frame) => frame.ids.length === 0)).toBe(true);
    await expect(previousActions.comment(firstEntry.id, "旧账号回复")).rejects.toThrow("登录状态已变化");
    await expect(previousActions.report(firstEntry.id, "comment-1", "spam")).rejects.toThrow("登录状态已变化");
    expect(annotationApi.addAnnotationComment).not.toHaveBeenCalled();
    expect(annotationApi.reportAnnotationComment).not.toHaveBeenCalled();
    await act(async () => { resolveWrite(firstEntry); resolveSecond([secondEntry]); });
    expect(await pendingWrite).toBeInstanceOf(Error);
    expect(result.current.threads.map((entry) => entry.id)).toEqual(["second-account"]);
    expect(frames.filter((frame) => frame.userId === "user-2").every((frame) => !frame.ids.includes(firstEntry.id))).toBe(true);
  });

  it("blocks reads and mutations when disabled, signed out, or unmounted", async () => {
    annotationApi.loadAnnotationThreads.mockResolvedValue([]);
    const entry = thread("chapter-1");
    const { result, rerender, unmount } = renderHook(
      ({ enabled, userId }: { enabled: boolean; userId: string | null }) => useAnnotationThreads(subject("chapter-1"), enabled, userId),
      { initialProps: { enabled: false, userId: "user-1" as string | null } },
    );
    const verifyBlocked = async (actions: typeof result.current) => {
      await expect(actions.create(entry)).rejects.toThrow("登录状态已变化");
      await expect(actions.comment(entry.id, "想法")).rejects.toThrow("登录状态已变化");
      await expect(actions.report(entry.id, "comment-1", "spam")).rejects.toThrow("登录状态已变化");
    };
    await verifyBlocked(result.current);
    rerender({ enabled: true, userId: null });
    await verifyBlocked(result.current);
    expect(annotationApi.loadAnnotationThreads).not.toHaveBeenCalled();
    rerender({ enabled: true, userId: "user-1" });
    await waitFor(() => expect(result.current.loading).toBe(false));
    const closedActions = result.current;
    unmount();
    await verifyBlocked(closedActions);
    await closedActions.refresh();
    expect(annotationApi.loadAnnotationThreads).toHaveBeenCalledTimes(1);
    expect(annotationApi.createAnnotation).not.toHaveBeenCalled();
    expect(annotationApi.addAnnotationComment).not.toHaveBeenCalled();
    expect(annotationApi.reportAnnotationComment).not.toHaveBeenCalled();
  });

  it("ignores a slow response from the previously selected chapter", async () => {
    let resolveFirst: (value: AnnotationThread[]) => void = () => undefined;
    const first = new Promise<AnnotationThread[]>((resolve) => { resolveFirst = resolve; });
    annotationApi.loadAnnotationThreads.mockImplementation((value: AnnotationSubject) => (
      value.sectionId === "chapter-1" ? first : Promise.resolve([thread("chapter-2")])
    ));

    const { result, rerender } = renderHook(
      ({ sectionId }) => useAnnotationThreads(subject(sectionId), true, "user-1"),
      { initialProps: { sectionId: "chapter-1" } },
    );
    rerender({ sectionId: "chapter-2" });

    await waitFor(() => expect(result.current.threads[0]?.sectionId).toBe("chapter-2"));
    await act(async () => { resolveFirst([thread("chapter-1")]); });
    expect(result.current.threads[0]?.sectionId).toBe("chapter-2");
  });

  it("fails closed for legacy responses while accepting aggregated public marks", async () => {
    annotationApi.loadAnnotationThreads.mockResolvedValue([
      thread("chapter-1"),
      { ...thread("chapter-1"), id: "legacy-other", authorId: "user-2" },
      {
        ...thread("chapter-1"),
        id: "shared",
        authorId: "user-2",
        underlineCount: 3,
        underlinedByMe: false,
        publiclyVisible: true,
      },
    ]);

    const { result } = renderHook(() => useAnnotationThreads(subject("chapter-1"), true, "user-1"));

    await waitFor(() => expect(result.current.threads).toHaveLength(2));
    expect(result.current.threads.map((value) => value.id)).toEqual(["annotation-chapter-1", "shared"]);
    expect(result.current.threads[0]).toMatchObject({ underlineCount: 1, underlinedByMe: true, publiclyVisible: false });
  });
});
