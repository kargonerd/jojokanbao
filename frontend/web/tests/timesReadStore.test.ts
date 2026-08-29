import { beforeEach, describe, expect, it, vi } from "vitest";

const readApi = vi.hoisted(() => ({
  loadTimesArticleReads: vi.fn(),
  markTimesArticleRead: vi.fn(),
  markTimesArticleUnread: vi.fn(),
}));
vi.mock("../src/times/readApi", () => readApi);

import {
  hydrateTimesReadState,
  markTimesArticleRead,
  markTimesArticleUnread,
  useTimesReadStore,
} from "../src/times/readStore";

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  useTimesReadStore.setState({ ownerKey: "", readById: {}, loadedById: {}, error: "" });
  readApi.loadTimesArticleReads.mockResolvedValue([{ articleId: "read-one", readAt: "2026-08-29T00:00:00Z" }]);
  readApi.markTimesArticleRead.mockResolvedValue(undefined);
  readApi.markTimesArticleUnread.mockResolvedValue(undefined);
});

describe("Times read state", () => {
  it("hydrates the current reader in one batch and persists toggles", async () => {
    await hydrateTimesReadState(["read-one", "unread-one"], "user-1");
    expect(readApi.loadTimesArticleReads).toHaveBeenCalledWith(["read-one", "unread-one"]);
    expect(useTimesReadStore.getState().readById).toMatchObject({ "read-one": true, "unread-one": false });

    await markTimesArticleRead("unread-one", "2026-08-29", "user-1");
    expect(readApi.markTimesArticleRead).toHaveBeenCalledWith("unread-one", "2026-08-29");
    await markTimesArticleUnread("read-one", "2026-08-29", "user-1");
    expect(readApi.markTimesArticleUnread).toHaveBeenCalledWith("read-one");
    expect(useTimesReadStore.getState().readById).toMatchObject({ "read-one": false, "unread-one": true });
  });

  it("keeps guest audit read state locally", async () => {
    await markTimesArticleRead("guest-one", "2026-08-29", null);
    useTimesReadStore.setState({ ownerKey: "", readById: {}, loadedById: {}, error: "" });
    await hydrateTimesReadState(["guest-one", "guest-two"], null);
    expect(useTimesReadStore.getState().readById).toMatchObject({ "guest-one": true, "guest-two": false });
    expect(readApi.loadTimesArticleReads).not.toHaveBeenCalled();
  });

  it("hydrates long infinite timelines in bounded batches", async () => {
    readApi.loadTimesArticleReads.mockResolvedValue([]);
    const ids = Array.from({ length: 501 }, (_, index) => `article-${index}`);

    await hydrateTimesReadState(ids, "user-1");

    expect(readApi.loadTimesArticleReads).toHaveBeenCalledTimes(2);
    expect(readApi.loadTimesArticleReads.mock.calls[0]![0]).toHaveLength(500);
    expect(readApi.loadTimesArticleReads.mock.calls[1]![0]).toEqual(["article-500"]);
    expect(useTimesReadStore.getState().loadedById["article-500"]).toBe(true);
  });

  it("does not let a stale hydration overwrite a newer read mutation", async () => {
    let resolveReads!: (rows: Array<{ articleId: string; readAt: string }>) => void;
    readApi.loadTimesArticleReads.mockImplementation(() => new Promise((resolve) => {
      resolveReads = resolve;
    }));

    const hydrating = hydrateTimesReadState(["article-1"], "user-1");
    await markTimesArticleRead("article-1", "2026-08-29", "user-1");
    resolveReads([]);
    await hydrating;

    expect(useTimesReadStore.getState().readById["article-1"]).toBe(true);
    expect(useTimesReadStore.getState().loadedById["article-1"]).toBe(true);
  });
});
