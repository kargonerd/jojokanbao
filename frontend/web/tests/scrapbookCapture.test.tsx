import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScrapbookDraft } from "@jojo/auth";
import { useAccountSessionStore } from "../src/account/session";
import { ScrapbookButton, ScrapbookCapture } from "../src/scrapbook/ScrapbookButton";

const mocks = vi.hoisted(() => ({
  repository: vi.fn(), collections: vi.fn(), save: vi.fn(), renderOwners: [] as Array<string | null>,
  editor: undefined as { initial: ScrapbookDraft; onSave: (value: ScrapbookDraft) => void } | undefined,
}));
vi.mock("../src/scrapbook/api", () => ({ scrapbookRepository: mocks.repository }));
vi.mock("../src/scrapbook/ScrapbookEditor", () => ({ ScrapbookEditor: (props: { initial: ScrapbookDraft; onSave: (value: ScrapbookDraft) => void }) => {
  mocks.editor = props;
  mocks.renderOwners.push(useAccountSessionStore.getState().userId);
  return <section role="dialog" aria-label="保存剪报"><p>{props.initial.quote}</p><button type="button" onClick={() => props.onSave({ ...props.initial, note: "甲账号的私人笔记" })}>保存剪报</button></section>;
} }));
const source = { contentType: "book" as const, contentId: "books:one", contentTitle: "城市交通史", sectionId: "chapter-1", locationLabel: "第一章", contentUrl: "/book/books/one?chapter=chapter-1" };
const quote = "甲账号选中的原文";
const repo = { collections: mocks.collections, save: mocks.save };
function openCapture(onClose = vi.fn(), onSaved = vi.fn()) {
  render(<MemoryRouter><ScrapbookCapture source={source} quote={quote} onClose={onClose} onSaved={onSaved} /></MemoryRouter>);
}
beforeEach(() => {
  mocks.repository.mockReset().mockResolvedValue(repo);
  mocks.collections.mockReset().mockResolvedValue([]);
  mocks.save.mockReset().mockResolvedValue({ id: "saved" });
  mocks.renderOwners.length = 0; mocks.editor = undefined;
  useAccountSessionStore.setState({ initialized: true, userId: "owner-a", displayName: "甲" });
});
afterEach(cleanup);

describe("scrapbook capture account ownership", () => {
  it("never renders an old standalone draft under a new account and rejects its retained callback", async () => {
    const close = vi.fn(); openCapture(close);
    expect(screen.getByRole("dialog")).toBeTruthy();
    const oldEditor = mocks.editor!;
    act(() => useAccountSessionStore.setState({ userId: "owner-b" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.renderOwners).not.toContain("owner-b");
    expect(close).toHaveBeenCalledTimes(1);
    await act(async () => oldEditor.onSave({ ...oldEditor.initial, note: "甲账号的私人笔记" }));
    expect(mocks.save).not.toHaveBeenCalled();
    // Even if a parent keeps this capture mounted, signing back in must not revive it.
    act(() => useAccountSessionStore.setState({ userId: "owner-a" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("discards a button snapshot before rendering a different owner's capture", async () => {
    render(<MemoryRouter><ScrapbookButton source={source} quote={quote} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "加入剪报本" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    act(() => useAccountSessionStore.setState({ userId: "owner-b" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.renderOwners).not.toContain("owner-b");
    expect(screen.queryByText("已加入剪报本")).toBeNull();
    act(() => useAccountSessionStore.setState({ userId: "owner-a" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("binds lazy repository loading to the opening owner and cancels a stale save before dispatch", async () => {
    let finish!: (value: typeof repo) => void;
    openCapture();
    await waitFor(() => expect(mocks.collections).toHaveBeenCalledTimes(1));
    mocks.repository.mockReturnValueOnce(new Promise<typeof repo>((resolve) => { finish = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "保存剪报" }));
    expect(mocks.repository).toHaveBeenLastCalledWith("owner-a");
    act(() => useAccountSessionStore.setState({ userId: "owner-b" }));
    await act(async () => finish(repo));
    expect(mocks.save).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("ignores a previous owner's save receipt after switching accounts", async () => {
    let finish!: (value: unknown) => void;
    mocks.save.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const close = vi.fn(), saved = vi.fn(); openCapture(close, saved);
    fireEvent.click(screen.getByRole("button", { name: "保存剪报" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    act(() => useAccountSessionStore.setState({ userId: "owner-b" }));
    await act(async () => finish({ id: "saved-for-a" }));
    expect(saved).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("saves and confirms a draft while its opening account remains active", async () => {
    const saved = vi.fn(), close = vi.fn(); openCapture(close, saved);
    fireEvent.click(screen.getByRole("button", { name: "保存剪报" }));
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
    expect(close).toHaveBeenCalledTimes(1);
    expect(mocks.repository.mock.calls.every(([owner]) => owner === "owner-a")).toBe(true);
    expect(mocks.save).toHaveBeenCalledWith({ ...source, quote, note: "甲账号的私人笔记", collection: "" });
  });
});
