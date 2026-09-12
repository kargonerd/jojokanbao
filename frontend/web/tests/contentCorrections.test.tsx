import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ userId: "reader" as string | null, submit: vi.fn(), list: vi.fn() }));
vi.mock("../src/account/session", () => ({ useAccountSessionStore: (selector: (state: { initialized: boolean; userId: string | null }) => unknown) => selector({ initialized: true, userId: mocks.userId }) }));
vi.mock("../src/corrections/api", () => ({ submitContentCorrection: mocks.submit, loadMyContentCorrections: mocks.list }));
import { ContentCorrectionButton } from "../src/corrections/ContentCorrectionButton";
const source = { contentType: "newspaper" as const, contentId: "rmrb:1980-01-01", contentTitle: "人民日报 1980-01-01", contentUrl: "/archive/rmrb/1980-01-01?page=3", sectionId: "3", locationLabel: "第 3 版" };
const receipt = { ...source, id: "01234567-0000-0000-0000-000000000000", category: "typo", details: "铁路一词有误", status: "pending", createdAt: "2026-09-08T00:00:00Z" };
function open() {
  render(<MemoryRouter initialEntries={[source.contentUrl]}><ContentCorrectionButton source={source} /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "内容纠错" }));
}
afterEach(cleanup);
beforeEach(() => { mocks.userId = "reader"; mocks.submit.mockReset().mockResolvedValue(receipt); mocks.list.mockReset().mockResolvedValue([]); });
describe("content correction dialog", () => {
  it("provides a login link retaining the reading location for signed out readers", () => {
    mocks.userId = null; open();
    expect(screen.getByRole("link", { name: "登录后纠错 →" }).getAttribute("href")).toBe(`/account?returnTo=${encodeURIComponent(source.contentUrl)}`);
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("submits exact page context and confirms only an acknowledged receipt", async () => {
    open();
    expect(screen.getByText("第 3 版")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("问题说明"), { target: { value: "铁路一词有误" } });
    fireEvent.click(screen.getByRole("button", { name: "提交纠错" }));
    expect(await screen.findByText("纠错已记录")).toBeTruthy();
    expect(mocks.submit).toHaveBeenCalledWith({ ...source, quote: "" }, "typo", "铁路一词有误", expect.any(String), "reader");
  });
  it("retains the form and retry key after an unsuccessful submission", async () => {
    mocks.submit.mockRejectedValueOnce(new Error("网络暂不可用")); open();
    fireEvent.change(screen.getByLabelText("问题说明"), { target: { value: "铁路一词有误" } });
    fireEvent.click(screen.getByRole("button", { name: "提交纠错" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("纠错已记录")).toBeNull();
    expect((screen.getByLabelText("问题说明") as HTMLTextAreaElement).value).toBe("铁路一词有误");
    fireEvent.click(screen.getByRole("button", { name: "提交纠错" }));
    await screen.findByText("纠错已记录");
    expect(mocks.submit.mock.calls[0]![3]).toBe(mocks.submit.mock.calls[1]![3]);
  });
  it("closes and ignores an old receipt when the account changes during submission", async () => {
    let resolve: (value: unknown) => void = () => undefined;
    mocks.submit.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const view = render(<MemoryRouter><ContentCorrectionButton source={source} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "内容纠错" }));
    fireEvent.change(screen.getByLabelText("问题说明"), { target: { value: "铁路一词有误" } });
    fireEvent.click(screen.getByRole("button", { name: "提交纠错" }));
    mocks.userId = "another-reader";
    view.rerender(<MemoryRouter><ContentCorrectionButton source={source} /></MemoryRouter>);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    resolve(receipt);
    await Promise.resolve();
    expect(screen.queryByText("纠错已记录")).toBeNull();
    expect(mocks.submit.mock.calls[0]![4]).toBe("reader");
  });
  it("shows previous resolution notes and returns focus when closed", async () => {
    mocks.list.mockResolvedValue([{ ...receipt, status: "resolved", resolutionNote: "文字已校正" }]); open();
    expect(await screen.findByText("编辑答复：文字已校正")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "内容纠错" }));
  });
});
