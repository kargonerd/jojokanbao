import { beforeEach, describe, expect, it, vi } from "vitest";

const notebookApi = vi.hoisted(() => ({
  list: vi.fn(),
}));
const askStream = vi.hoisted(() => vi.fn(() => vi.fn()));

vi.mock("../src/rag/api", () => ({ notebookApi, askStream }));

import { useChatStore } from "../src/rag/stores/chatStore";

describe("RAG chat scope", () => {
  beforeEach(() => {
    window.localStorage.clear();
    notebookApi.list.mockReset();
    askStream.mockClear();
    useChatStore.setState({
      notebooks: [],
      selectedNotebookIds: [],
      scopeMode: "single",
      messages: [],
      loading: false,
      error: null,
      streaming: false,
      streamContent: "",
      conversationId: null,
    });
  });

  it("starts with one book and replaces it in single-book mode", async () => {
    notebookApi.list.mockResolvedValue([
      { id: "book-a", title: "甲书" },
      { id: "book-b", title: "乙书" },
    ]);

    await useChatStore.getState().loadNotebooks();
    expect(useChatStore.getState().selectedNotebookIds).toEqual(["book-a"]);

    useChatStore.getState().selectNotebook("book-b");
    expect(useChatStore.getState().selectedNotebookIds).toEqual(["book-b"]);
    expect(useChatStore.getState().scopeMode).toBe("single");
  });

  it("sends every selected book in multi-book mode", async () => {
    notebookApi.list.mockResolvedValue([
      { id: "book-a", title: "甲书" },
      { id: "book-b", title: "乙书" },
    ]);

    await useChatStore.getState().loadNotebooks();
    useChatStore.getState().setScopeMode("multiple");
    useChatStore.getState().toggleNotebook("book-b");
    useChatStore.getState().sendMessage("比较两本书");

    expect(useChatStore.getState().selectedNotebookIds).toEqual(["book-a", "book-b"]);
    expect(askStream).toHaveBeenCalledWith(
      expect.objectContaining({
        datasetIds: ["book-a", "book-b"],
        question: "比较两本书",
      }),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("does not restore a book after it was removed from a multi-book scope", async () => {
    notebookApi.list.mockResolvedValue([
      { id: "book-a", title: "甲书" },
      { id: "book-b", title: "乙书" },
    ]);

    await useChatStore.getState().loadNotebooks();
    useChatStore.getState().setScopeMode("multiple");
    useChatStore.getState().toggleNotebook("book-b");
    useChatStore.getState().toggleNotebook("book-b");

    expect(useChatStore.getState().selectedNotebookIds).toEqual(["book-a"]);
    expect(window.localStorage.getItem("rag-last-notebook")).toBe("book-a");
  });
});
