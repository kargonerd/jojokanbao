import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnnotationDiscussionPanel } from "../src/annotations/AnnotationDiscussionPanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const thread = {
  id: "annotation-1",
  contentType: "book" as const,
  contentId: "book-1",
  sectionId: "chapter-1",
  contentTitle: "测试书",
  authorId: "user-1",
  authorName: "划线者-AAA",
  quote: "被划线的原文",
  prefix: "",
  suffix: "",
  startOffset: 0,
  endOffset: 7,
  createdAt: "2026-08-18T10:00:00Z",
  comments: [{
    id: "comment-1",
    annotationId: "annotation-1",
    parentCommentId: null,
    authorId: "user-2",
    authorName: "其他读者-BBB",
    body: "第一条评论",
    visibility: "public" as const,
    createdAt: "2026-08-18T10:01:00Z",
    reportedByMe: false,
  }],
};

describe("AnnotationDiscussionPanel", () => {
  it("keeps the visibility choice and draft while the mobile keyboard opens, pans, and closes", async () => {
    const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
    const removeViewportListener = vi.spyOn(viewport, "removeEventListener");
    vi.stubGlobal("visualViewport", viewport);
    vi.stubGlobal("innerHeight", 844);
    const onComment = vi.fn(async () => undefined);
    const { unmount } = render(<AnnotationDiscussionPanel thread={thread} currentUserId="user-1" onClose={vi.fn()} onLike={vi.fn()} onComment={onComment} onReport={vi.fn()} />);
    const panel = screen.getByRole("complementary", { name: "划线详情" });
    const draft = screen.getByPlaceholderText<HTMLTextAreaElement>("写下你的想法……");
    fireEvent.change(draft, { target: { value: "只留给自己的想法" } });
    fireEvent.click(screen.getByRole("radio", { name: "仅自己可见" }));

    viewport.height = 380;
    act(() => { viewport.dispatchEvent(new Event("resize")); });
    expect(panel.style.getPropertyValue("--annotation-viewport-height")).toBe("380px");
    viewport.offsetTop = 48;
    act(() => { viewport.dispatchEvent(new Event("scroll")); });
    expect(panel.style.getPropertyValue("--annotation-viewport-top")).toBe("48px");
    expect(draft.value).toBe("只留给自己的想法");
    expect(screen.getByRole("radio", { name: "仅自己可见" }).getAttribute("aria-checked")).toBe("true");

    viewport.height = 844;
    viewport.offsetTop = 0;
    act(() => { viewport.dispatchEvent(new Event("resize")); });
    expect(panel.style.getPropertyValue("--annotation-viewport-height")).toBe("844px");
    expect(panel.style.getPropertyValue("--annotation-viewport-top")).toBe("0px");
    fireEvent.click(screen.getByRole("button", { name: "发表想法" }));
    await waitFor(() => expect(onComment).toHaveBeenCalledWith("只留给自己的想法", undefined, "private"));
    unmount();
    expect(removeViewportListener).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(removeViewportListener).toHaveBeenCalledWith("scroll", expect.any(Function));
  });

  it("adapts to window resize when visualViewport is unavailable", () => {
    vi.stubGlobal("visualViewport", undefined);
    vi.stubGlobal("innerHeight", 844);
    render(<AnnotationDiscussionPanel thread={thread} currentUserId="user-1" onClose={vi.fn()} onLike={vi.fn()} onComment={vi.fn()} onReport={vi.fn()} />);
    const panel = screen.getByRole("complementary", { name: "划线详情" });
    expect(panel.style.getPropertyValue("--annotation-viewport-height")).toBe("844px");
    vi.stubGlobal("innerHeight", 420);
    fireEvent(window, new Event("resize"));
    expect(panel.style.getPropertyValue("--annotation-viewport-height")).toBe("420px");
    expect(panel.style.getPropertyValue("--annotation-viewport-top")).toBe("0px");
  });

  it("keeps a long quote keyboard-accessible with comments and the composer outside its scroll area", () => {
    const quote = "很长的所选原文。".repeat(200);
    render(<AnnotationDiscussionPanel thread={{ ...thread, quote }} currentUserId="user-1" onClose={vi.fn()} onLike={vi.fn()} onComment={vi.fn()} onReport={vi.fn()} />);
    const quoteRegion = screen.getByLabelText("划线原文内容");
    expect(quoteRegion.textContent).toBe(quote);
    expect(quoteRegion.tabIndex).toBe(0);
    expect(quoteRegion.contains(screen.getByText("第一条评论"))).toBe(false);
    expect(quoteRegion.contains(screen.getByPlaceholderText("写下你的想法……"))).toBe(false);
    expect(screen.getByRole("radio", { name: "公开" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "仅自己可见" })).toBeTruthy();
  });

  it("deletes my underline once, then keeps public thoughts and the real zero count", async () => {
    let finish!: () => void;
    const onDeleteMark = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const props = { thread: { ...thread, underlinedByMe: true, underlineCount: 1 }, currentUserId: "user-1", onClose: vi.fn(), onComment: vi.fn(), onReport: vi.fn(), onLike: vi.fn(), onDeleteMark };
    const { rerender } = render(<AnnotationDiscussionPanel {...props} />);
    const button = screen.getByRole("button", { name: "删除划线" });
    fireEvent.click(button); fireEvent.click(button);
    expect(onDeleteMark).toHaveBeenCalledTimes(1);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { finish(); });
    rerender(<AnnotationDiscussionPanel {...props} thread={{ ...thread, underlinedByMe: false, underlineCount: 0 }} />);
    expect(screen.queryByRole("button", { name: "删除划线" })).toBeNull();
    expect(screen.getByText("0 人划线")).toBeTruthy();
    expect(screen.getByText("第一条评论")).toBeTruthy();
  });
  it("sorts public thoughts and replies by likes with stable chronological ties", () => {
    const comment = thread.comments[0]!;
    const comments = [
      { ...comment, id: "new", body: "新想法", likeCount: 2, createdAt: "2026-08-18T11:00:00Z" },
      { ...comment, id: "old", body: "旧想法", likeCount: 2 },
      { ...comment, id: "reply", body: "热门回复", parentCommentId: "old", likeCount: 8 },
    ];
    const { container } = render(<AnnotationDiscussionPanel thread={{ ...thread, comments }} currentUserId="user-1" onClose={vi.fn()} onLike={vi.fn()} onComment={vi.fn()} onReport={vi.fn()} />);
    expect([...container.querySelectorAll(".annotation-comments > li > p")].map((p) => p.textContent)).toEqual(["热门回复", "旧想法", "新想法"]);
    expect(within(screen.getAllByRole("listitem")[0]!).getByText("回复 其他读者-BBB")).toBeTruthy();
    expect(comments[0]?.id).toBe("new");
  });

  it("sends the desired like state, prevents duplicate clicks, and supports unliking", async () => {
    let finish!: () => void;
    const onLike = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const props = { thread, currentUserId: "user-1", onClose: vi.fn(), onComment: vi.fn(), onReport: vi.fn(), onLike };
    const { rerender } = render(<AnnotationDiscussionPanel {...props} />);
    const button = screen.getByRole("button", { name: "点赞，0 个赞" });
    fireEvent.click(button); fireEvent.click(button);
    expect(onLike).toHaveBeenCalledExactlyOnceWith("comment-1", true);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { finish(); });
    rerender(<AnnotationDiscussionPanel {...props} thread={{ ...thread, comments: [{ ...thread.comments[0]!, likeCount: 1, likedByMe: true }] }} />);
    const unlike = screen.getByRole("button", { name: "取消点赞，1 个赞" });
    expect(unlike.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(unlike);
    expect(onLike).toHaveBeenLastCalledWith("comment-1", false);
    await act(async () => { finish(); });
  });

  it("keeps the original count and allows retry after a failed like", async () => {
    const onLike = vi.fn().mockRejectedValueOnce(new Error("网络连接失败")).mockResolvedValue(undefined);
    render(<AnnotationDiscussionPanel thread={thread} currentUserId="user-1" onClose={vi.fn()} onLike={onLike} onComment={vi.fn()} onReport={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "点赞，0 个赞" }));
    expect(await screen.findByText("网络连接失败")).toBeTruthy();
    const button = screen.getByRole("button", { name: "点赞，0 个赞" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(onLike).toHaveBeenCalledTimes(2));
  });
  it("continues another reader's comment as a reply", async () => {
    const onComment = vi.fn(async () => undefined);
    render(<AnnotationDiscussionPanel thread={thread} currentUserId="user-1" onClose={vi.fn()} onLike={vi.fn()} onComment={onComment} onReport={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "回复" }));
    expect(screen.getByText("回复 其他读者-BBB")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("写下你的想法……"), { target: { value: "接着讨论" } });
    fireEvent.click(screen.getByRole("button", { name: "发表想法" }));
    await waitFor(() => expect(onComment).toHaveBeenCalledWith("接着讨论", "comment-1", "public"));
  });

  it("submits a categorized report for another reader's comment", async () => {
    const onReport = vi.fn(async () => undefined);
    render(<AnnotationDiscussionPanel thread={thread} currentUserId="user-1" onClose={vi.fn()} onLike={vi.fn()} onComment={vi.fn()} onReport={onReport} />);
    fireEvent.click(screen.getByRole("button", { name: "举报" }));
    fireEvent.click(screen.getByRole("radio", { name: "辱骂或攻击" }));
    fireEvent.change(screen.getByPlaceholderText("补充说明（选填）"), { target: { value: "包含人身攻击" } });
    fireEvent.click(screen.getByRole("button", { name: "提交举报" }));
    await waitFor(() => expect(onReport).toHaveBeenCalledWith("comment-1", "abuse", "包含人身攻击"));
  });

  it("renders untrusted names and comments as plain text", () => {
    const unsafeThread = {
      ...thread,
      authorName: "<img src=x onerror=alert(1)>",
      comments: [{
        ...thread.comments[0]!,
        authorName: "<script>alert(2)</script>",
        body: "<svg onload=alert(3)>",
      }],
    };
    const { container } = render(<AnnotationDiscussionPanel thread={unsafeThread} currentUserId="user-1" onClose={vi.fn()} onLike={vi.fn()} onComment={vi.fn()} onReport={vi.fn()} />);

    expect(screen.getByText("<script>alert(2)</script>")).toBeTruthy();
    expect(screen.getByText("<svg onload=alert(3)>")).toBeTruthy();
    expect(container.querySelector("script, svg[onload], img[onerror]")).toBeNull();
  });

  it("labels a private thought without exposing discussion actions", () => {
    const privateThread = {
      ...thread,
      comments: [{ ...thread.comments[0]!, authorId: "user-1", visibility: "private" as const }],
    };
    render(<AnnotationDiscussionPanel thread={privateThread} currentUserId="user-1" onClose={vi.fn()} onLike={vi.fn()} onComment={vi.fn()} onReport={vi.fn()} />);

    expect(document.querySelector(".annotation-comment__byline em")?.textContent).toBe("仅自己可见");
    expect(screen.queryByRole("button", { name: "回复" })).toBeNull();
    expect(screen.queryByRole("button", { name: "举报" })).toBeNull();
    expect(screen.queryByRole("button", { name: /点赞/ })).toBeNull();
  });

  it("shows the aggregated underline count without listing reader identities", () => {
    render(<AnnotationDiscussionPanel
      thread={{ ...thread, underlineCount: 4, underlinedByMe: false, publiclyVisible: true }}
      currentUserId="user-1"
      onClose={vi.fn()} onLike={vi.fn()}
      onComment={vi.fn()}
      onReport={vi.fn()}
    />);

    expect(screen.getByText("4 人划线")).toBeTruthy();
    expect(screen.queryByText("划线者-AAA 划线", { exact: false })).toBeNull();
  });

  it("does not add a private-visibility note beside a personal underline", () => {
    render(<AnnotationDiscussionPanel
      thread={{ ...thread, underlineCount: 1, underlinedByMe: true, publiclyVisible: false }}
      currentUserId="user-1"
      onClose={vi.fn()} onLike={vi.fn()}
      onComment={vi.fn()}
      onReport={vi.fn()}
    />);

    expect(screen.getByText("1 人划线")).toBeTruthy();
    expect(screen.queryByText("仅在你的阅读器显示")).toBeNull();
  });

  it("renders SVG icons on like, reply, and delete action buttons", () => {
    const threadWithOwnComment = {
      ...thread,
      comments: [
        { ...thread.comments[0]!, authorId: "user-1", likeCount: 5 },
      ],
    };
    render(<AnnotationDiscussionPanel
      thread={threadWithOwnComment}
      currentUserId="user-1"
      onClose={vi.fn()}
      onLike={vi.fn()}
      onComment={vi.fn()}
      onReport={vi.fn()}
      onDeleteComment={vi.fn()}
    />);

    const likeButton = screen.getByRole("button", { name: "点赞，5 个赞" });
    const replyButton = screen.getByRole("button", { name: "回复" });
    const deleteButton = screen.getByRole("button", { name: "删除想法" });

    expect(likeButton.querySelector("svg")).toBeTruthy();
    expect(replyButton.querySelector("svg")).toBeTruthy();
    expect(deleteButton.querySelector("svg")).toBeTruthy();
  });

  it("deletes reader's own thought, displays loading state, and reports error on failure", async () => {
    let resolveDelete!: () => void;
    let rejectDelete!: (err: Error) => void;
    const onDeleteComment = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((res, rej) => { resolveDelete = res; rejectDelete = rej; }))
      .mockRejectedValueOnce(new Error("网络异常，删除失败"));

    const threadWithOwnComment = {
      ...thread,
      comments: [
        { ...thread.comments[0]!, authorId: "user-1", body: "我要删除的想法" },
        { ...thread.comments[0]!, id: "comment-other", authorId: "user-2", body: "别人想法" },
      ],
    };
    const { rerender } = render(<AnnotationDiscussionPanel
      thread={threadWithOwnComment}
      currentUserId="user-1"
      onClose={vi.fn()}
      onLike={vi.fn()}
      onComment={vi.fn()}
      onReport={vi.fn()}
      onDeleteComment={onDeleteComment}
    />);

    // Only own comment has delete button
    const deleteButtons = screen.getAllByRole("button", { name: "删除想法" });
    expect(deleteButtons).toHaveLength(1);

    fireEvent.click(deleteButtons[0]!);
    expect(onDeleteComment).toHaveBeenCalledWith("comment-1");
    expect(deleteButtons[0]!.textContent).toContain("删除中…");
    expect((deleteButtons[0]! as HTMLButtonElement).disabled).toBe(true);

    // Resolve deletion
    await act(async () => { resolveDelete(); });
    expect(await screen.findByText("已删除想法。")).toBeTruthy();

    // Rerender with failure case
    rerender(<AnnotationDiscussionPanel
      thread={threadWithOwnComment}
      currentUserId="user-1"
      onClose={vi.fn()}
      onLike={vi.fn()}
      onComment={vi.fn()}
      onReport={vi.fn()}
      onDeleteComment={onDeleteComment}
    />);

    const retryDeleteButton = screen.getAllByRole("button", { name: "删除想法" })[0]!;
    fireEvent.click(retryDeleteButton);
    expect(await screen.findByText("网络异常，删除失败")).toBeTruthy();
  });

  it("allows deleting own private thought while hiding reply and like actions", async () => {
    const onDeleteComment = vi.fn(async () => undefined);
    const privateThread = {
      ...thread,
      comments: [{ ...thread.comments[0]!, authorId: "user-1", visibility: "private" as const, body: "私密日记想法" }],
    };
    render(<AnnotationDiscussionPanel
      thread={privateThread}
      currentUserId="user-1"
      onClose={vi.fn()}
      onLike={vi.fn()}
      onComment={vi.fn()}
      onReport={vi.fn()}
      onDeleteComment={onDeleteComment}
    />);

    expect(screen.queryByRole("button", { name: "回复" })).toBeNull();
    expect(screen.queryByRole("button", { name: /点赞/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "举报" })).toBeNull();

    const deleteButton = screen.getByRole("button", { name: "删除想法" });
    expect(deleteButton).toBeTruthy();
    expect(deleteButton.querySelector("svg")).toBeTruthy();

    fireEvent.click(deleteButton);
    await waitFor(() => expect(onDeleteComment).toHaveBeenCalledWith("comment-1"));
  });
});
