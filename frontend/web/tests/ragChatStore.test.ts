import { beforeEach, describe, expect, it, vi } from "vitest";

const notebookApi = vi.hoisted(() => ({
  list: vi.fn(),
  getSources: vi.fn(),
}));
const localConversationApi = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));
const askStream = vi.hoisted(() => vi.fn((..._args: unknown[]) => vi.fn()));

vi.mock("../src/rag/api", () => ({ notebookApi, askStream }));
vi.mock("../src/rag/local-conversations", () => ({ localConversationApi }));

import { useChatStore } from "../src/rag/stores/chatStore";

describe("RAG chat scope", () => {
  beforeEach(() => {
    window.localStorage.clear();
    notebookApi.list.mockReset();
    notebookApi.getSources.mockReset();
    notebookApi.getSources.mockResolvedValue([]);
    localConversationApi.list.mockReset();
    localConversationApi.list.mockResolvedValue([]);
    localConversationApi.get.mockReset();
    localConversationApi.put.mockReset();
    localConversationApi.put.mockResolvedValue(undefined);
    localConversationApi.delete.mockReset();
    localConversationApi.delete.mockResolvedValue(undefined);
    askStream.mockClear();
    useChatStore.setState({
      notebooks: [],
      selectedNotebookIds: [],
      messages: [],
      conversations: [],
      loading: false,
      historyLoading: false,
      error: null,
      streaming: false,
      streamContent: "",
      streamStatus: "",
      conversationId: null,
    });
  });

  it("starts with all AI-enabled books and supports an optional multi-book scope", async () => {
    notebookApi.list.mockResolvedValue([
      { id: "book-a", title: "甲书" },
      { id: "book-b", title: "乙书" },
    ]);

    await useChatStore.getState().loadNotebooks();
    expect(useChatStore.getState().selectedNotebookIds).toEqual([]);

    useChatStore.getState().toggleNotebook("book-a");
    useChatStore.getState().toggleNotebook("book-b");
    expect(useChatStore.getState().selectedNotebookIds).toEqual(["book-a", "book-b"]);
    useChatStore.getState().toggleNotebook("book-a");
    expect(useChatStore.getState().selectedNotebookIds).toEqual(["book-b"]);
    useChatStore.getState().selectNotebook(null);
    expect(useChatStore.getState().selectedNotebookIds).toEqual([]);
  });

  it("sends every explicitly selected book as one scoped question", async () => {
    notebookApi.list.mockResolvedValue([
      { id: "book-a", title: "甲书" },
      { id: "book-b", title: "乙书" },
    ]);

    await useChatStore.getState().loadNotebooks();
    useChatStore.getState().toggleNotebook("book-a");
    useChatStore.getState().toggleNotebook("book-b");
    useChatStore.getState().sendMessage("比较两本书");

    await vi.waitFor(() => {
      expect(askStream).toHaveBeenCalledWith(
        expect.objectContaining({
          datasetIds: ["book-a", "book-b"],
          scopeMode: "selected",
          question: "比较两本书",
        }),
        expect.any(Function),
        expect.any(Function),
        expect.any(Function),
        expect.any(Function),
      );
    });
    expect(notebookApi.getSources).not.toHaveBeenCalled();
  });

  it("sends all AI-enabled book ids when the reader asks without choosing a scope", async () => {
    notebookApi.list.mockResolvedValue([
      { id: "book-a", title: "甲书" },
      { id: "book-b", title: "乙书" },
    ]);

    await useChatStore.getState().loadNotebooks();
    useChatStore.getState().sendMessage("直接比较两本书");

    expect(useChatStore.getState().selectedNotebookIds).toEqual([]);
    await vi.waitFor(() => {
      expect(askStream).toHaveBeenCalledWith(
        expect.objectContaining({
          datasetIds: ["book-a", "book-b"],
          scopeMode: "all",
          question: "直接比较两本书",
        }),
        expect.any(Function),
        expect.any(Function),
        expect.any(Function),
        expect.any(Function),
      );
    });
    expect(notebookApi.getSources).not.toHaveBeenCalled();
  });

  it("restores a local conversation with its scope and citations", async () => {
    notebookApi.list.mockResolvedValue([{ id: "book-a", title: "甲书" }]);
    localConversationApi.list.mockResolvedValue([{
      id: "conv_saved",
      title: "历史问题",
      messageCount: 2,
      scope: { datasetIds: ["book-a"] },
    }]);
    localConversationApi.get.mockResolvedValue({
      conversation: {
        id: "conv_saved",
        title: "历史问题",
        messageCount: 2,
        scope: { datasetIds: ["book-a"] },
      },
      messages: [
        { role: "user", content: "历史问题" },
        {
          role: "assistant",
          content: "历史回答",
          references: [{
            datasetId: "book-a",
            itemId: "book-a:item-a",
            targetId: "chapter:1",
          }],
        },
      ],
    });
    window.localStorage.setItem("rag-last-conversation", "conv_saved");

    await useChatStore.getState().loadNotebooks();

    expect(useChatStore.getState()).toMatchObject({
      conversationId: "conv_saved",
      selectedNotebookIds: ["book-a"],
      messages: [
        { role: "user", content: "历史问题" },
        {
          role: "assistant",
          content: "历史回答",
          references: [{ targetId: "chapter:1" }],
        },
      ],
    });
  });

  it("restores an all-books conversation without presenting it as a manual selection", async () => {
    notebookApi.list.mockResolvedValue([
      { id: "book-a", title: "甲书" },
      { id: "book-b", title: "乙书" },
    ]);
    localConversationApi.list.mockResolvedValue([{
      id: "conv_all",
      title: "全库问题",
      messageCount: 2,
      scope: { mode: "all", datasetIds: ["book-a", "book-b"] },
    }]);
    localConversationApi.get.mockResolvedValue({
      conversation: {
        id: "conv_all",
        title: "全库问题",
        messageCount: 2,
        scope: { mode: "all", datasetIds: ["book-a", "book-b"] },
      },
      messages: [
        { role: "user", content: "全库问题" },
        { role: "assistant", content: "全库回答" },
      ],
    });
    window.localStorage.setItem("rag-last-conversation", "conv_all");

    await useChatStore.getState().loadNotebooks();

    expect(useChatStore.getState()).toMatchObject({
      conversationId: "conv_all",
      selectedNotebookIds: [],
    });
  });

  it("sends the single book's static manifest for local Agent search", async () => {
    notebookApi.list.mockResolvedValue([{ id: "book-a", title: "甲书" }]);
    notebookApi.getSources.mockResolvedValue([{
      id: "item-a",
      itemId: "book-a:item-a",
      manifestObject: "content/books/book-a/items/item-a/manifest.jox",
    }]);
    await useChatStore.getState().loadNotebooks();
    useChatStore.getState().selectNotebook("book-a");

    useChatStore.getState().sendMessage("查找劳动价值");

    await vi.waitFor(() => expect(askStream).toHaveBeenCalledWith(
      expect.objectContaining({
        datasetIds: ["book-a"],
        scopeMode: "selected",
        itemIds: ["book-a:item-a"],
        manifestObjects: ["content/books/book-a/items/item-a/manifest.jox"],
      }),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    ));
  });

  it("saves a completed conversation locally and sends prior messages as client history", async () => {
    notebookApi.list.mockResolvedValue([{ id: "book-a", title: "甲书" }]);
    askStream.mockImplementationOnce((...args: unknown[]) => {
      const [params, onChunk, onDone] = args as [
        { history?: Array<{ role: string; content: string }> },
        (chunk: string) => void,
        (references: unknown[], conversationId: string) => void,
      ];
      expect(params.history).toEqual([
        { role: "user", content: "上一问" },
        { role: "assistant", content: "上一答" },
      ]);
      onChunk("本轮回答");
      onDone([], "conv_local");
      return vi.fn();
    });
    useChatStore.setState({
      notebooks: [{ id: "book-a", title: "甲书" }],
      messages: [
        { role: "user", content: "上一问" },
        { role: "assistant", content: "上一答" },
      ],
      conversationId: "conv_local",
    });

    useChatStore.getState().sendMessage("继续问");

    await vi.waitFor(() => expect(localConversationApi.put).toHaveBeenCalledTimes(1));
    expect(localConversationApi.put).toHaveBeenCalledWith(expect.objectContaining({
      conversation: expect.objectContaining({
        id: "conv_local",
        title: "上一问",
        messageCount: 4,
      }),
      messages: expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "继续问" }),
        expect.objectContaining({ role: "assistant", content: "本轮回答" }),
      ]),
    }));
  });
});
