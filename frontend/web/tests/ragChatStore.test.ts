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
      contentType: "book",
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

  it("starts with all sources and supports an optional multi-book scope", async () => {
    notebookApi.list.mockResolvedValue([
      { id: "book-a", title: "甲书" },
      { id: "book-b", title: "乙书" },
    ]);

    await useChatStore.getState().loadNotebooks();
    expect(useChatStore.getState().contentType).toBe("all");
    expect(useChatStore.getState().selectedNotebookIds).toEqual(["rmrb", "book-a", "book-b"]);
    useChatStore.getState().selectNotebook(null);
    expect(useChatStore.getState().selectedNotebookIds).toEqual([]);
    useChatStore.getState().sendMessage("不应该发送");
    expect(askStream).not.toHaveBeenCalled();

    useChatStore.getState().toggleNotebook("book-a");
    useChatStore.getState().toggleNotebook("book-b");
    expect(useChatStore.getState().selectedNotebookIds).toEqual(["book-a", "book-b"]);
    useChatStore.getState().toggleNotebook("book-a");
    expect(useChatStore.getState().selectedNotebookIds).toEqual(["book-b"]);
    useChatStore.getState().selectNotebook(null);
    expect(useChatStore.getState().selectedNotebookIds).toEqual(["rmrb", "book-a", "book-b"]);
    useChatStore.getState().selectNotebook(null);
    expect(useChatStore.getState().selectedNotebookIds).toEqual([]);
  });

  it("sends and saves a periodical scope without loading book manifests", async () => {
    await useChatStore.getState().selectContentType("periodical");
    useChatStore.getState().selectNotebook("rmrb");
    askStream.mockImplementationOnce((...args: unknown[]) => {
      const [params, onChunk, onDone] = args as [
        { contentType: string; datasetIds: string[] }, (text: string) => void,
        (refs: unknown[], conversationId: string) => void,
      ];
      expect(params).toMatchObject({ contentType: "periodical", datasetIds: ["rmrb"] });
      onChunk("报道原文");
      onDone([], "conv_paper");
      return vi.fn();
    });
    useChatStore.getState().sendMessage("人民日报如何报道黄河？");
    await vi.waitFor(() => expect(localConversationApi.put).toHaveBeenCalledWith(expect.objectContaining({
      conversation: expect.objectContaining({ scope: { contentType: "periodical", mode: "all", datasetIds: ["rmrb"] } }),
    })));
    expect(notebookApi.getSources).not.toHaveBeenCalled();
    const saved = localConversationApi.put.mock.calls[0]?.[0];
    localConversationApi.get.mockResolvedValue(saved);
    useChatStore.getState().selectContentType("book");
    expect(useChatStore.getState()).toMatchObject({ selectedNotebookIds: ["rmrb"], conversationId: "conv_paper" });
    expect(useChatStore.getState().messages).toHaveLength(2);
    await useChatStore.getState().openConversation("conv_paper");
    expect(useChatStore.getState()).toMatchObject({ contentType: "periodical", selectedNotebookIds: ["rmrb"] });
  });

  it("locks the picker during streaming and preserves selection when switching tabs", async () => {
    useChatStore.setState({ notebooks: [{ id: "book-a" }], selectedNotebookIds: ["book-a"], streaming: true });
    useChatStore.getState().selectContentType("periodical");
    expect(useChatStore.getState().contentType).toBe("book");
    useChatStore.setState({ streaming: false });
    useChatStore.getState().selectContentType("periodical");
    useChatStore.getState().toggleNotebook("book-a");
    expect(useChatStore.getState().selectedNotebookIds).toEqual(["book-a"]);
    useChatStore.getState().sendMessage("黄河");
    await vi.waitFor(() => expect(askStream.mock.calls[0]?.[0]).toMatchObject({ contentType: "book", datasetIds: ["book-a"], scopeMode: "all" }));
  });

  it.each([{ selection: ["rmrb", "book-a"] }, { selection: ["rmrb"] }])("saves and restores a combined scope %j", async ({ selection }) => {
    notebookApi.list.mockResolvedValue([{ id: "book-a", title: "甲书" }]);
    await useChatStore.getState().loadNotebooks();
    useChatStore.getState().selectNotebook(null);
    for (const id of selection) useChatStore.getState().toggleNotebook(id);
    askStream.mockImplementationOnce((...args: unknown[]) => {
      const onDone = args[2] as (refs: unknown[], id: string) => void;
      onDone([], "conv-mixed");
      return vi.fn();
    });
    useChatStore.getState().sendMessage("调查研究");
    await vi.waitFor(() => expect(localConversationApi.put).toHaveBeenCalledTimes(1));
    const saved = localConversationApi.put.mock.calls[0]?.[0];
    const contentType = selection.length === 2 ? "all" : "periodical";
    expect(saved.conversation.scope).toEqual({ contentType, mode: "all", datasetIds: selection });
    useChatStore.getState().selectContentType("book");
    localConversationApi.get.mockResolvedValue(saved);
    await useChatStore.getState().openConversation("conv-mixed");
    expect(useChatStore.getState()).toMatchObject({ contentType, selectedNotebookIds: selection });
  });

  it("sends every explicitly selected book as one scoped question", async () => {
    notebookApi.list.mockResolvedValue([
      { id: "book-a", title: "甲书" },
      { id: "book-b", title: "乙书" },
    ]);

    await useChatStore.getState().loadNotebooks();
    useChatStore.getState().selectNotebook(null);
    useChatStore.getState().toggleNotebook("book-a");
    useChatStore.getState().toggleNotebook("book-b");
    useChatStore.getState().sendMessage("比较两本书");

    await vi.waitFor(() => {
      expect(askStream).toHaveBeenCalledWith(
        expect.objectContaining({
          datasetIds: ["book-a", "book-b"],
          contentType: "book",
          scopeMode: "all",
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

  it("sends all periodical and AI-enabled book ids by default", async () => {
    notebookApi.list.mockResolvedValue([
      { id: "book-a", title: "甲书" },
      { id: "book-b", title: "乙书" },
    ]);

    await useChatStore.getState().loadNotebooks();
    useChatStore.getState().sendMessage("直接比较两本书");

    expect(useChatStore.getState().selectedNotebookIds).toEqual(["rmrb", "book-a", "book-b"]);
    await vi.waitFor(() => {
      expect(askStream).toHaveBeenCalledWith(
        expect.objectContaining({
          contentType: "all",
          datasetIds: ["rmrb", "book-a", "book-b"],
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

  it("keeps hidden selections and sends the selected sources regardless of the active tab", async () => {
    notebookApi.list.mockResolvedValue([{ id: "book-a", title: "甲书" }, { id: "book-b", title: "乙书" }]);
    await useChatStore.getState().loadNotebooks();
    useChatStore.getState().selectContentType("book");
    expect(useChatStore.getState().selectedNotebookIds).toEqual(["rmrb", "book-a", "book-b"]);
    useChatStore.getState().selectNotebook(null);
    expect(useChatStore.getState().selectedNotebookIds).toEqual(["rmrb"]);
    useChatStore.getState().selectContentType("all");
    expect(useChatStore.getState().selectedNotebookIds).toEqual(["rmrb"]);
    useChatStore.getState().selectContentType("book");
    useChatStore.getState().sendMessage("仍然查询报刊");
    expect(askStream.mock.calls[0]?.[0]).toMatchObject({ contentType: "periodical", datasetIds: ["rmrb"] });
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
      contentType: "book",
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

  it("restores an all-books conversation with every book selected", async () => {
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
      selectedNotebookIds: ["book-a", "book-b"],
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
    useChatStore.getState().selectContentType("book");
    useChatStore.getState().selectNotebook("book-a");

    useChatStore.getState().sendMessage("查找劳动价值");

    await vi.waitFor(() => expect(askStream).toHaveBeenCalledWith(
      expect.objectContaining({
        datasetIds: ["book-a"],
        scopeMode: "all",
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
      selectedNotebookIds: ["book-a"],
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
