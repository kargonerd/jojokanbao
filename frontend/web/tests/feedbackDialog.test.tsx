import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeedbackDialog } from "../src/feedback/FeedbackDialog";

const feedbackApi = vi.hoisted(() => ({ submitFeedback: vi.fn(() => "sent" as const) }));
vi.mock("@jojo/analytics/feedback", () => feedbackApi);

describe("FeedbackDialog", () => {
  afterEach(() => { feedbackApi.submitFeedback.mockReset(); feedbackApi.submitFeedback.mockReturnValue("sent"); cleanup(); });

  it("submits a general report with the chosen topic and confirms delivery", async () => {
    const onClose = vi.fn();
    render(<FeedbackDialog open onClose={onClose} screen="account" />);

    fireEvent.change(screen.getByLabelText("反馈内容"), { target: { value: "翻页后目录高亮没有更新" } });
    fireEvent.click(screen.getByRole("button", { name: "功能建议" }));
    fireEvent.click(screen.getByRole("button", { name: "提交反馈" }));

    expect(await screen.findByRole("status")).toHaveProperty("textContent", "已提交，感谢你的反馈。");
    expect(feedbackApi.submitFeedback).toHaveBeenCalledWith({ topic: "suggestion", message: "翻页后目录高亮没有更新", screen: "account" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("quotes the selected passage and pins the correction topic", async () => {
    const onClose = vi.fn();
    render(<FeedbackDialog open onClose={onClose} correction={{
      quote: "今日耍闻", contentType: "periodical", contentId: "people:20260901", contentTitle: "人民日报 2026-09-01",
    }} screen="archive_reader" />);

    expect(screen.getByText("今日耍闻")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "功能建议" })).toBeNull();
    fireEvent.change(screen.getByLabelText("问题说明"), { target: { value: "应为「今日要闻」" } });
    fireEvent.click(screen.getByRole("button", { name: "提交反馈" }));

    await waitFor(() => expect(feedbackApi.submitFeedback).toHaveBeenCalledWith({
      topic: "content_correction", message: "应为「今日要闻」", quote: "今日耍闻", contentType: "periodical",
      contentId: "people:20260901", contentTitle: "人民日报 2026-09-01", screen: "archive_reader",
    }));
  });

  it("keeps the form open and explains when the analytics channel is unavailable", async () => {
    feedbackApi.submitFeedback.mockReturnValue("unavailable" as never);
    const onClose = vi.fn();
    render(<FeedbackDialog open onClose={onClose} />);

    fireEvent.change(screen.getByLabelText("反馈内容"), { target: { value: "任意问题" } });
    fireEvent.click(screen.getByRole("button", { name: "提交反馈" }));

    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "使用统计未开启或尚未就绪，暂时无法提交反馈。");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("requires a message before enabling submission", () => {
    render(<FeedbackDialog open onClose={vi.fn()} />);
    const submit = screen.getByRole("button", { name: "提交反馈" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("反馈内容"), { target: { value: "   " } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("反馈内容"), { target: { value: "有内容了" } });
    expect(submit.disabled).toBe(false);
  });
});
