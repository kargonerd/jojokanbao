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
  vi.clearAllMocks();
});

describe("useAnnotationThreads", () => {
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
