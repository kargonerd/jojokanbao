import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnnotationSubject, AnnotationThread, TextAnchor } from "@jojo/content/annotations";

const { rpc, getSession, authLoaded, setHeader } = vi.hoisted(() => ({ rpc: vi.fn(), getSession: vi.fn(), authLoaded: vi.fn(), setHeader: vi.fn() }));
vi.mock("../account/auth", () => {
  authLoaded();
  return { mobileAuthClient: {
    rpc: (name: string, params: Record<string, unknown>) => ({ setHeader: (header: string, value: string) => {
      setHeader(header, value);
      return rpc(name, params);
    } }),
    auth: { getSession },
  } };
});

const subject: AnnotationSubject = {
  contentType: "book", contentId: "dataset:item", sectionId: "chapter:2", contentTitle: "示例书",
  contentUrl: "/rag/books/dataset/item?chapter=chapter%3A2",
};
const anchor: TextAnchor = { quote: "第二章原文", prefix: "前文", suffix: "后文", startOffset: 6, endOffset: 12 };
const savedThread: AnnotationThread = {
  ...subject, ...anchor, id: "saved", authorId: "reader:a", authorName: "读者",
  createdAt: "2026-09-12T00:00:00Z", underlinedByMe: true, comments: [],
};
let api: typeof import("./api");

describe("native annotation RPC binding", () => {
  beforeEach(async () => {
    vi.resetModules();
    rpc.mockReset().mockResolvedValue({ data: savedThread, error: null });
    getSession.mockReset().mockResolvedValue({ data: { session: { user: { id: "reader:a" }, access_token: "token-a" } }, error: null });
    setHeader.mockReset();
    authLoaded.mockClear();
    api = await import("./api");
  });

  it("loads the native auth client lazily and submits private thoughts to the deployed RPC", async () => {
    expect(authLoaded).not.toHaveBeenCalled();
    expect(await api.createAnnotation(subject, anchor, "  仅自己可见  ", "private")).toEqual(savedThread);
    expect(authLoaded).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("create_content_annotation", {
      p_content_type: "book", p_content_id: "dataset:item", p_section_id: "chapter:2",
      p_content_title: "示例书", p_content_url: subject.contentUrl,
      p_quote: "第二章原文", p_prefix: "前文", p_suffix: "后文", p_start_offset: 6, p_end_offset: 12,
      p_initial_comment: "仅自己可见", p_initial_comment_visibility: "private",
    });
    expect(getSession).toHaveBeenCalledTimes(3);
    expect(setHeader).toHaveBeenCalledExactlyOnceWith("Authorization", "Bearer token-a");
  });

  it("uses real discussion and personal-note reads and reuses successful native chapter requests", async () => {
    rpc.mockResolvedValue({ data: [savedThread], error: null });
    expect(await api.loadAnnotationThreads(subject)).toEqual([savedThread]);
    expect(await api.loadMyBookAnnotations(subject.contentId, [subject.sectionId], "reader:a")).toEqual([savedThread]);
    expect(await api.loadMyBookAnnotations(subject.contentId, [subject.sectionId], "reader:a")).toEqual([savedThread]);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenLastCalledWith("get_annotation_threads", {
      p_content_type: "book", p_content_id: "dataset:item", p_section_id: "chapter:2",
    });
  });

  it("sends private reply and report parameters while leaving public visibility at its database default", async () => {
    await api.addAnnotationComment("saved", "  回复  ", "parent", "private");
    expect(rpc).toHaveBeenLastCalledWith("add_annotation_comment", {
      p_annotation_id: "saved", p_body: "回复", p_parent_comment_id: "parent", p_visibility: "private",
    });
    await api.addAnnotationComment("saved", "公开回复");
    expect(rpc.mock.calls.at(-1)?.[1]).not.toHaveProperty("p_visibility");
    await api.reportAnnotationComment("comment", "harassment", "  说明  ");
    expect(rpc).toHaveBeenLastCalledWith("report_annotation_comment", {
      p_comment_id: "comment", p_reason: "harassment", p_details: "说明",
    });
  });

  it("rejects previous-account requests before calling native RPCs", async () => {
    getSession.mockResolvedValue({ data: { session: { user: { id: "reader:b" }, access_token: "token-b" } }, error: null });
    await expect(api.loadMyBookAnnotations(subject.contentId, [subject.sectionId], "reader:a"))
      .rejects.toThrow("登录状态已变化");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("does not serve cached notes when the native session is no longer available", async () => {
    rpc.mockResolvedValue({ data: [savedThread], error: null });
    await api.loadMyBookAnnotations(subject.contentId, [subject.sectionId], "reader:a");
    getSession.mockResolvedValue({ data: { session: null }, error: null });
    await expect(api.loadMyBookAnnotations(subject.contentId, [subject.sectionId], "reader:a"))
      .rejects.toThrow("登录状态已变化");
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("does not submit a draft after auth changed before the initial session capture", async () => {
    getSession.mockResolvedValue({ data: { session: { user: { id: "reader:b" }, access_token: "token-b" } }, error: null });
    await expect(api.createAnnotation(subject, anchor, "旧账号草稿", "private", "reader:a")).rejects.toThrow("登录状态已变化");
    expect(rpc).not.toHaveBeenCalled();
    expect(setHeader).not.toHaveBeenCalled();
  });

  it("rejects an account change between identity capture and RPC credential capture", async () => {
    getSession.mockResolvedValueOnce({ data: { session: { user: { id: "reader:a" }, access_token: "token-a" } }, error: null })
      .mockResolvedValue({ data: { session: { user: { id: "reader:b" }, access_token: "token-b" } }, error: null });
    await expect(api.addAnnotationComment("saved", "旧账号回复", undefined, "private", "reader:a")).rejects.toThrow("登录状态已变化");
    expect(rpc).not.toHaveBeenCalled();
    expect(setHeader).not.toHaveBeenCalled();
  });

  it("retains the original session Authorization if live auth switches at transport time", async () => {
    setHeader.mockImplementation(() => {
      getSession.mockResolvedValue({ data: { session: { user: { id: "reader:b" }, access_token: "token-b" } }, error: null });
    });
    await expect(api.createAnnotation(subject, anchor, "自己的私密草稿", "private", "reader:a")).rejects.toThrow("登录状态已变化");
    expect(setHeader).toHaveBeenCalledExactlyOnceWith("Authorization", "Bearer token-a");
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("never falls back to another session when the expected reader has no token", async () => {
    getSession.mockResolvedValue({ data: { session: { user: { id: "reader:a" } } }, error: null });
    await expect(api.createAnnotation(subject, anchor, "私密草稿", "private", "reader:a")).rejects.toThrow("登录状态已变化");
    expect(rpc).not.toHaveBeenCalled();
    expect(setHeader).not.toHaveBeenCalled();
  });
});
