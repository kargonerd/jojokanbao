import { expect, it, vi } from "vitest";
import { openOfflineBook, startOfflineAccountSync, offlineBooks, requestOfflinePersistence } from "../src/offline/books";
import { enableDesktopOfflineBooks, supportsOfflineBooks } from "../src/offline/platform";
import { browserOfflineBookIdentity } from "../src/offline/identity";
import { useAccountSessionStore } from "../src/account/session";
const list = vi.hoisted(() => vi.fn());
vi.mock("../src/offline/repository", () => ({ browserOfflineBookRepository: { list } }));

it("does not restore local identity, open downloads, or initialize storage on Web", async () => {
  useAccountSessionStore.setState({ initialized: false, userId: null });
  localStorage.setItem("jojo-auth-session", JSON.stringify({ user: { id: "old-reader" } }));
  expect(supportsOfflineBooks()).toBe(false);
  expect(browserOfflineBookIdentity().userId).toBeNull();
  startOfflineAccountSync();
  await expect(openOfflineBook("books", "one")).resolves.toBeUndefined();
  await expect(requestOfflinePersistence()).rejects.toThrow("客户端书架");
  await expect(offlineBooks.download({ datasetId: "books", itemKey: "one" })).rejects.toThrow();
  expect(list).not.toHaveBeenCalled();
  enableDesktopOfflineBooks();
  expect(supportsOfflineBooks()).toBe(true);
  localStorage.clear();
});
