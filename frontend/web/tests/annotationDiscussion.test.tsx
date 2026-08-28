import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnnotationDiscussionPanel } from "../src/annotations/AnnotationDiscussionPanel";

afterEach(cleanup);

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
  it("continues another reader's comment as a reply", async () => {
    const onComment = vi.fn(async () => undefined);
    render(<AnnotationDiscussionPanel thread={thread} currentUserId="user-1" onClose={vi.fn()} onComment={onComment} onReport={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "回复" }));
    expect(screen.getByText("回复 其他读者-BBB")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("写下你的想法……"), { target: { value: "接着讨论" } });
    fireEvent.click(screen.getByRole("button", { name: "发表想法" }));
    await waitFor(() => expect(onComment).toHaveBeenCalledWith("接着讨论", "comment-1", "public"));
  });

  it("submits a categorized report for another reader's comment", async () => {
    const onReport = vi.fn(async () => undefined);
    render(<AnnotationDiscussionPanel thread={thread} currentUserId="user-1" onClose={vi.fn()} onComment={vi.fn()} onReport={onReport} />);
    fireEvent.click(screen.getByRole("button", { name: "举报" }));
    fireEvent.change(screen.getByRole("combobox", { name: "举报原因" }), { target: { value: "abuse" } });
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
    const { container } = render(<AnnotationDiscussionPanel thread={unsafeThread} currentUserId="user-1" onClose={vi.fn()} onComment={vi.fn()} onReport={vi.fn()} />);

    expect(screen.getByText("<script>alert(2)</script>")).toBeTruthy();
    expect(screen.getByText("<svg onload=alert(3)>")).toBeTruthy();
    expect(container.querySelector("script, svg[onload], img[onerror]")).toBeNull();
  });

  it("labels a private thought without exposing discussion actions", () => {
    const privateThread = {
      ...thread,
      comments: [{ ...thread.comments[0]!, authorId: "user-1", visibility: "private" as const }],
    };
    render(<AnnotationDiscussionPanel thread={privateThread} currentUserId="user-1" onClose={vi.fn()} onComment={vi.fn()} onReport={vi.fn()} />);

    expect(document.querySelector(".annotation-comment__byline em")?.textContent).toBe("仅自己可见");
    expect(screen.queryByRole("button", { name: "回复" })).toBeNull();
    expect(screen.queryByRole("button", { name: "举报" })).toBeNull();
  });

  it("shows the aggregated underline count without listing reader identities", () => {
    render(<AnnotationDiscussionPanel
      thread={{ ...thread, underlineCount: 4, underlinedByMe: false, publiclyVisible: true }}
      currentUserId="user-1"
      onClose={vi.fn()}
      onComment={vi.fn()}
      onReport={vi.fn()}
    />);

    expect(screen.getByText("4 人划线")).toBeTruthy();
    expect(screen.queryByText("划线者-AAA 划线", { exact: false })).toBeNull();
  });
});
