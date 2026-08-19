import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ list: vi.fn(), moderate: vi.fn() }));
vi.mock("./api", () => ({ moderationApi: api }));

import { ModerationPage } from "./ModerationPage";

const item = {
  commentId: "comment-1",
  annotationId: "annotation-1",
  commentBody: "这是一条需要审核的评论。",
  commentStatus: "visible" as const,
  commentAuthorName: "读者-ABC",
  commentCreatedAt: "2026-08-18T10:00:00Z",
  quote: "被划线的原文",
  contentType: "book",
  contentId: "book-1",
  sectionId: "chapter-1",
  contentTitle: "测试书 · 第一章",
  contentUrl: "/book/test/book-1",
  reportCount: 2,
  reports: [{ id: "report-1", reason: "abuse", status: "pending" as const, reporterName: "举报人-XYZ", createdAt: "2026-08-18T11:00:00Z" }],
};

describe("ModerationPage", () => {
  beforeEach(() => {
    api.list.mockReset();
    api.moderate.mockReset();
    api.list.mockResolvedValue([item]);
    api.moderate.mockResolvedValue(undefined);
  });
  afterEach(cleanup);

  it("shows report evidence and moderates with an explicit reason", async () => {
    render(<ModerationPage />);
    expect(await screen.findByText("这是一条需要审核的评论。")).toBeInTheDocument();
    expect(screen.getByText("被划线的原文")).toBeInTheDocument();
    expect(screen.getByText("辱骂或攻击")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "填写审核理由" }));
    fireEvent.change(screen.getByPlaceholderText("填写审核理由"), { target: { value: "确认违反社区规则" } });
    fireEvent.click(screen.getByRole("button", { name: "隐藏评论" }));

    await waitFor(() => expect(api.moderate).toHaveBeenCalledWith("comment-1", "hide", "确认违反社区规则"));
  });

  it("switches queues without asking for a browser token", async () => {
    render(<ModerationPage />);
    await screen.findByText("这是一条需要审核的评论。");
    fireEvent.click(screen.getByRole("tab", { name: "已处理" }));
    await waitFor(() => expect(api.list).toHaveBeenCalledWith("resolved"));
    expect(screen.queryByLabelText(/token/i)).not.toBeInTheDocument();
  });

  it("ignores a slow response from the previously selected queue", async () => {
    let resolvePending: (items: typeof item[]) => void = () => undefined;
    api.list.mockImplementation((status: string) => status === "pending"
      ? new Promise((resolve) => { resolvePending = resolve; })
      : Promise.resolve([{ ...item, commentId: "resolved-comment", commentBody: "已处理队列", commentStatus: "hidden", reports: [{ ...item.reports[0], status: "resolved" }] }]));
    render(<ModerationPage />);
    fireEvent.click(screen.getByRole("tab", { name: "已处理" }));
    expect(await screen.findByText("已处理队列")).toBeInTheDocument();

    resolvePending([item]);
    await Promise.resolve();
    expect(screen.queryByText("这是一条需要审核的评论。")).toBeNull();
    expect(screen.getByText("已处理队列")).toBeInTheDocument();
  });

  it("offers restore but not dismiss for an already resolved hidden comment", async () => {
    api.list.mockResolvedValue([{ ...item, commentStatus: "hidden", reports: [{ ...item.reports[0], status: "resolved" }] }]);
    render(<ModerationPage />);
    expect(await screen.findByRole("button", { name: "恢复评论" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "驳回举报" })).toBeNull();
  });
});
