import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ list: vi.fn(), review: vi.fn() }));
vi.mock("./api", () => ({ correctionsApi: api }));
import { CorrectionsPage } from "./CorrectionsPage";
const item = { id: "c1", contentType: "book", contentId: "test:book", contentTitle: "测试书", contentUrl: "/book/test/book?chapter=2", sectionId: "2", locationLabel: "第二章", quote: "错误原文", category: "typo", details: "应为铁路", status: "pending", createdAt: "2026-09-08T00:00:00Z" };
afterEach(cleanup);
beforeEach(() => { api.list.mockReset().mockResolvedValue({ items: [item], total: 1 }); api.review.mockReset().mockResolvedValue(undefined); });
describe("content correction management", () => {
  it("shows source context and saves an explicit resolution", async () => {
    render(<CorrectionsPage />);
    expect(await screen.findByText("错误原文")).toBeTruthy();
    expect(screen.getByText("/book/test/book?chapter=2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "处理纠错" }));
    fireEvent.change(screen.getByLabelText("处理状态"), { target: { value: "resolved" } });
    fireEvent.change(screen.getByLabelText("处理说明"), { target: { value: "原文已校正" } });
    fireEvent.click(screen.getByRole("button", { name: "保存处理结果" }));
    await waitFor(() => expect(api.review).toHaveBeenCalledWith("c1", "resolved", "原文已校正"));
  });
  it("discards a delayed response from a previously selected queue", async () => {
    let finish: (result: { items: typeof item[]; total: number }) => void = () => undefined;
    api.list.mockImplementation((status: string) => status === "pending" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({ items: [{ ...item, details: "核查中记录" }], total: 1 }));
    render(<CorrectionsPage />);
    fireEvent.click(screen.getByRole("tab", { name: "核查中" }));
    expect(await screen.findByText("核查中记录")).toBeTruthy();
    finish({ items: [item], total: 1 });
    await Promise.resolve();
    expect(screen.queryByText("应为铁路")).toBeNull();
  });
});
