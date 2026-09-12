import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OfflineBookRecord } from "@jojo/content";
import { BookshelfPage } from "../src/library/BookshelfPage";
import { useAccountSessionStore } from "../src/account/session";
import { useFeatureFlagStore } from "../src/featureFlags";

const mocks = vi.hoisted(() => ({
  desktop: false, records: [] as OfflineBookRecord[], loading: false,
  load: vi.fn(), set: vi.fn(), start: vi.fn(), download: vi.fn(), remove: vi.fn(), persist: vi.fn(),
}));
vi.mock("../src/offline/platform", () => ({ supportsOfflineBooks: () => mocks.desktop }));
vi.mock("../src/offline/books", () => ({
  startOfflineAccountSync: mocks.start, requestOfflinePersistence: mocks.persist,
  offlineBooks: { download: mocks.download, remove: mocks.remove },
  useOfflineBooksStore: (select: (state: unknown) => unknown) => select({ books: mocks.records, loading: mocks.loading, error: "" }),
}));
vi.mock("../src/rag/readerData", () => ({ loadBookshelf: mocks.load, setBookshelf: mocks.set }));
vi.mock("../src/library/BookCover", () => ({ BookCover: () => <span>封面</span> }));
const entry = { datasetId: "books", itemId: "book:one", title: "一本书" };
function record(status: OfflineBookRecord["status"] = "ready") {
  return { id: "one", scope: "public", entry: { datasetId: "books" }, item: { itemId: "book:one", itemKey: "one", title: "一本书" }, status, bytes: 2048, completed: 4, total: 10 } as OfflineBookRecord;
}
function shelf() { return <MemoryRouter><BookshelfPage /></MemoryRouter>; }
beforeEach(() => {
  vi.clearAllMocks(); mocks.desktop = false; mocks.records = []; mocks.loading = false;
  mocks.load.mockResolvedValue([entry]); mocks.set.mockResolvedValue(undefined);
  mocks.persist.mockResolvedValue(undefined); mocks.download.mockResolvedValue(undefined); mocks.remove.mockResolvedValue(undefined);
  useAccountSessionStore.setState({ initialized: true, userId: "reader" });
  useFeatureFlagStore.setState({ initialized: true, flags: { "library.bookshelf": true, "reader.annotations": false, "reader.speech": false } });
});
afterEach(cleanup);

it("keeps Web shelves free of offline entries, controls and initialization", async () => {
  mocks.records = [record()]; render(shelf());
  await screen.findByText("一本书");
  expect(screen.queryByRole("button", { name: /下载|可离线/ })).toBeNull();
  expect(screen.queryByRole("link", { name: /离线/ })).toBeNull();
  expect(mocks.start).not.toHaveBeenCalled();
});

it("shows local downloads during an offline cold start without waiting for cloud auth", () => {
  mocks.desktop = true; mocks.records = [record()];
  useAccountSessionStore.setState({ initialized: false, userId: null });
  render(shelf());
  expect(screen.getByRole("button", { name: "可离线：一本书" })).toBeTruthy();
  expect(screen.getByRole("link", { name: /一本书/ }).getAttribute("href")).toBe("/book/books/one");
  expect(screen.queryByRole("button", { name: /移出/ })).toBeNull();
  expect(mocks.load).not.toHaveBeenCalled();
});

it("deduplicates the cloud ID and local item key, deleting only the download", async () => {
  mocks.desktop = true; mocks.records = [record()]; const view = render(shelf());
  await waitFor(() => expect(screen.getByRole("button", { name: "移出书架：一本书" })).toBeTruthy());
  expect(screen.getAllByText("一本书")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "可离线：一本书" }));
  fireEvent.click(screen.getByRole("button", { name: "删除下载：一本书" }));
  await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith(mocks.records[0]));
  mocks.records = []; view.rerender(shelf());
  expect(screen.getByRole("button", { name: "下载：一本书" })).toBeTruthy();
  expect(mocks.set).not.toHaveBeenCalled();
});

it("keeps downloaded books readable when the cloud shelf fails", async () => {
  mocks.desktop = true; mocks.records = [record()]; mocks.load.mockRejectedValue(new Error("offline"));
  render(shelf());
  await screen.findByText("云端书架暂时无法同步，已下载的书可以继续阅读。");
  expect(screen.getByRole("link", { name: /一本书/ })).toBeTruthy();
});

it("downloads from the book card and leaves a failed download retryable", async () => {
  mocks.desktop = true; mocks.download.mockRejectedValueOnce(new Error("设备空间不足"));
  render(shelf());
  fireEvent.click(await screen.findByRole("button", { name: "下载：一本书" }));
  await screen.findByRole("alert");
  expect(mocks.download).toHaveBeenCalledWith({ datasetId: "books", itemKey: "book:one", title: "一本书" });
  fireEvent.click(screen.getByRole("button", { name: "下载：一本书" }));
  await waitFor(() => expect(mocks.download).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

it("shows progress and cancels the selected download on its card", async () => {
  mocks.desktop = true; mocks.records = [record("downloading")]; render(shelf());
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("40");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "取消下载：一本书" })));
  expect(mocks.remove).toHaveBeenCalledWith(mocks.records[0]);
  expect(mocks.set).not.toHaveBeenCalled();
});
