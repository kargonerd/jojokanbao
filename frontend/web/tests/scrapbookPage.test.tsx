import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScrapbookEntry } from "@jojo/auth";
import { ScrapbookPage } from "../src/scrapbook/ScrapbookPage";
import { useAccountSessionStore } from "../src/account/session";

const repo = vi.hoisted(() => ({ list: vi.fn(), collections: vi.fn(), save: vi.fn(), remove: vi.fn() }));
vi.mock("../src/scrapbook/api", () => ({ scrapbookRepository: async () => repo }));
vi.mock("../src/scrapbook/ScrapbookEditor", () => ({ ScrapbookEditor: () => null }));
function entry(id = "one", title = "旧专题材料"): ScrapbookEntry {
  return { id, contentType: "book", contentId: "books:one", contentTitle: title, sectionId: "chapter-1",
    locationLabel: "第一章", contentUrl: "/book/books/one?chapter=chapter-1", quote: "铁路通车", note: "", collection: "",
    createdAt: "2026-09-08T01:00:00Z", updatedAt: "2026-09-08T01:00:00Z" };
}
function open() { render(<MemoryRouter><ScrapbookPage /></MemoryRouter>); }
beforeEach(() => {
  vi.clearAllMocks();
  repo.list.mockReset().mockResolvedValue([entry()]);
  repo.collections.mockReset().mockResolvedValue(["*", "新专题"]);
  repo.remove.mockReset().mockResolvedValue(undefined);
  useAccountSessionStore.setState({ initialized: true, userId: "owner-a", displayName: "读者" });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("scrapbook navigation and async results", () => {
  it("allows a literal star topic and adds excerpt location when returning to the book", async () => {
    open();
    const link = await screen.findByRole("link", { name: "返回原文" });
    const source = new URL(link.getAttribute("href")!, "https://reader.test");
    expect(source.searchParams.get("chapter")).toBe("chapter-1");
    expect(source.searchParams.get("quote")).toBe("铁路通车");
    expect(source.searchParams.get("returnTo")).toBe("/scrapbook");
    fireEvent.change(screen.getByRole("combobox", { name: "筛选专题" }), { target: { value: JSON.stringify("*") } });
    await waitFor(() => expect(repo.list).toHaveBeenLastCalledWith("", "*", 0));
  });
  it("refreshes the current filter when a deletion completes after the reader changes topics", async () => {
    let finish!: () => void;
    repo.remove.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    repo.list.mockImplementation(async (_query: string, collection: string | null) => [entry(collection || "old", collection === "新专题" ? "新专题材料" : "旧专题材料")]);
    open();
    await screen.findByText("旧专题材料");
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    fireEvent.change(screen.getByRole("combobox", { name: "筛选专题" }), { target: { value: JSON.stringify("新专题") } });
    await screen.findByText("新专题材料");
    expect((screen.getByRole("button", { name: "编辑" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish());
    await waitFor(() => expect(repo.list.mock.calls.filter((args) => args[1] === "新专题")).toHaveLength(2));
    expect(repo.list).toHaveBeenLastCalledWith("", "新专题", 0);
    expect(screen.queryByText("旧专题材料")).toBeNull();
  });
  it("discards a previous account's delayed list after sign-out and sign-in", async () => {
    let finish!: (entries: ScrapbookEntry[]) => void;
    repo.list.mockReturnValueOnce(new Promise<ScrapbookEntry[]>((resolve) => { finish = resolve; })).mockResolvedValue([entry("b", "乙账号材料")]);
    open();
    await waitFor(() => expect(repo.list).toHaveBeenCalledTimes(1));
    act(() => useAccountSessionStore.setState({ userId: null }));
    expect(screen.getByText("登录后保存你的剪报")).toBeTruthy();
    act(() => useAccountSessionStore.setState({ userId: "owner-b" }));
    await screen.findByText("乙账号材料");
    await act(async () => finish([entry("a", "甲账号材料")]));
    expect(screen.queryByText("甲账号材料")).toBeNull();
    expect(screen.getByText("乙账号材料")).toBeTruthy();
  });
  it("exports all filtered pages, including entries not yet loaded on screen", async () => {
    repo.list.mockImplementation(async (_query: string, _collection: string | null, offset: number) => offset === 50
      ? [entry("last", "最后一条")]
      : Array.from({ length: 50 }, (_, index) => entry(String(index), `剪报${index}`)));
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:clippings") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    open();
    await screen.findByText("剪报0");
    expect(screen.queryByText("最后一条")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "导出 Markdown" }));
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
    expect(repo.list.mock.calls.map((args) => args[2])).toEqual([0, 0, 50]);
  });
});
