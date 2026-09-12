import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const askStream = vi.hoisted(() => vi.fn(() => vi.fn()));

vi.mock("../src/rag/api", () => ({ notebookApi, askStream }));
vi.mock("../src/rag/local-conversations", () => ({ localConversationApi }));

import { ChatPage } from "../src/rag/pages/ChatPage";
import { useChatStore } from "../src/rag/stores/chatStore";

describe("RAG chat page", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    notebookApi.list.mockReset();
    notebookApi.list.mockResolvedValue([
      { id: "book-a", title: "甲书" },
      { id: "book-b", title: "乙书" },
    ]);
    notebookApi.getSources.mockReset();
    notebookApi.getSources.mockResolvedValue([]);
    localConversationApi.list.mockReset();
    localConversationApi.list.mockResolvedValue([]);
    localConversationApi.get.mockReset();
    localConversationApi.put.mockReset();
    localConversationApi.delete.mockReset();
    askStream.mockReset();
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

  afterEach(() => cleanup());

  it("keeps the range picker open while selecting multiple books", async () => {
    render(<ChatPage />);
    await screen.findByRole("textbox", { name: "输入问题" });
    fireEvent.click(screen.getByRole("button", { name: "书籍" }));
    fireEvent.click(screen.getByRole("button", { name: "全部书籍 默认范围" }));

    const first = screen.getByRole("button", { name: "甲书" });
    const second = screen.getByRole("button", { name: "乙书" });
    fireEvent.click(first);
    fireEvent.click(second);

    expect(first.getAttribute("aria-pressed")).toBe("true");
    expect(second.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText("选择资料，当前全部书籍")).toBeTruthy();
    expect(screen.getByRole("button", { name: "完成" })).toBeTruthy();
  });

  it("starts with only the question composer and plain scope controls", async () => {
    render(<ChatPage />);
    await screen.findByRole("textbox", { name: "输入问题" });

    expect(screen.getByRole("form", { name: "提问" })).toBeTruthy();
    expect(screen.getByRole("note", { name: "AI 实验功能说明" }).textContent).toContain("回答可能不准确、遗漏或误解原文");
    expect(screen.getByLabelText("选择资料，当前全部报刊 + 书籍")).toBeTruthy();
    expect(screen.getByRole("button", { name: "全部" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "人民日报" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "甲书" })).toBeTruthy();
    expect(screen.queryByText("馆藏原文 · 随问随查")).toBeNull();
    expect(screen.queryByText("想了解什么，直接问。")).toBeNull();
    expect(screen.queryByText("无需先选书")).toBeNull();
  });

  it("switches between books and the sole supported periodical and clears the filter", async () => {
    render(<ChatPage />);
    await screen.findByRole("textbox", { name: "输入问题" });
    fireEvent.click(screen.getByRole("button", { name: "书籍" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "筛选书籍" }), { target: { value: "甲" } });
    fireEvent.click(screen.getByRole("button", { name: "报刊" }));
    expect(screen.queryByRole("button", { name: "甲书" })).toBeNull();
    expect(screen.getByRole("button", { name: "人民日报" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "参考消息" })).toBeNull();
    expect(screen.getByLabelText("选择资料，当前报刊 · 人民日报")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "书籍" }));
    expect(screen.getByRole("button", { name: "甲书" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "人民日报" })).toBeNull();
  });

  it("allows mixed selection and resets new conversations to all sources", async () => {
    render(<ChatPage />);
    await screen.findByRole("textbox", { name: "输入问题" });
    fireEvent.click(screen.getByRole("button", { name: "乙书" }));
    expect(screen.getByLabelText("选择资料，当前限定 2 份资料")).toBeTruthy();
    expect(useChatStore.getState().selectedNotebookIds).toEqual(["rmrb", "book-a"]);
    fireEvent.click(screen.getByRole("button", { name: "报刊" }));
    fireEvent.click(screen.getAllByRole("button", { name: /新对话/ })[0]!);
    expect(screen.getByLabelText("选择资料，当前全部报刊 + 书籍")).toBeTruthy();
  });

  it("checks every source with select all, clears every source on deselection, and blocks empty questions", async () => {
    render(<ChatPage />);
    await screen.findByRole("textbox", { name: "输入问题" });
    const all = screen.getByRole("button", { name: "全部报刊 + 书籍 默认范围" });
    const paper = screen.getByRole("button", { name: "人民日报" });
    const book = screen.getByRole("button", { name: "甲书" });
    expect(paper.getAttribute("aria-pressed")).toBe("true");
    expect(book.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(all);
    expect(all.getAttribute("aria-pressed")).toBe("false");
    expect(paper.getAttribute("aria-pressed")).toBe("false");
    expect(book.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByLabelText("选择资料，当前未选择资料")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "输入问题" }), { target: { value: "调查研究" } });
    expect(screen.getByRole("button", { name: "发送" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(book);
    expect(all.getAttribute("aria-pressed")).toBe("mixed");
    expect(screen.getByRole("button", { name: "发送" }).hasAttribute("disabled")).toBe(false);
    fireEvent.change(screen.getByRole("searchbox", { name: "筛选资料" }), { target: { value: "甲" } });
    fireEvent.click(all);
    expect(all.getAttribute("aria-pressed")).toBe("true");
    expect(useChatStore.getState().selectedNotebookIds).toEqual(["rmrb", "book-a", "book-b"]);
  });

  it("locks the composer while a historical conversation is loading", async () => {
    let resolveConversation: ((value: {
      conversation: { id: string; title: string; messageCount: number };
      messages: Array<{ role: "user" | "assistant"; content: string }>;
    }) => void) | undefined;
    localConversationApi.list.mockResolvedValue([{
      id: "conv-history",
      title: "历史问题",
      messageCount: 2,
      lastMessageAt: Date.now(),
    }]);
    localConversationApi.get.mockImplementation(() => new Promise((resolve) => {
      resolveConversation = resolve;
    }));

    render(<ChatPage />);
    const [historyButton] = await screen.findAllByRole("button", { name: /^历史问题 / });
    fireEvent.click(historyButton!);

    expect(await screen.findByText("正在加载对话…")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "输入问题" }), {
      target: { value: "不能提前发送" },
    });
    expect(screen.getByRole("button", { name: "发送" }).hasAttribute("disabled")).toBe(true);

    await act(async () => {
      resolveConversation?.({
        conversation: { id: "conv-history", title: "历史问题", messageCount: 2 },
        messages: [
          { role: "user", content: "历史问题" },
          { role: "assistant", content: "历史回答" },
        ],
      });
    });

    expect(await screen.findByText("历史回答")).toBeTruthy();
    expect(screen.getByRole("button", { name: "发送" }).hasAttribute("disabled")).toBe(false);
  });

  it("places a readable service error after the user's question", async () => {
    render(<ChatPage />);
    await waitFor(() => expect(useChatStore.getState().loading).toBe(false));

    act(() => useChatStore.setState({
      messages: [{ role: "user", content: "你好" }],
      error: "Trusted service authentication required",
    }));

    expect(screen.getByText("你好")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("AI 服务版本不一致。请刷新页面后重新提问。");
    expect(screen.queryByText("Trusted service authentication required")).toBeNull();
  });

  it("shows the Agent's current streamed tool activity", async () => {
    render(<ChatPage />);
    await waitFor(() => expect(useChatStore.getState().loading).toBe(false));

    act(() => useChatStore.setState({
      messages: [{ role: "user", content: "什么是剩余价值" }],
      streaming: true,
      streamContent: "",
      streamStatus: "正在候选书籍中检索原文：“剩余价值”…",
    }));

    expect(screen.getByRole("status").textContent).toContain("正在候选书籍中检索原文");
    expect(screen.getByText("正在查找")).toBeTruthy();
  });

  it("does not expose the implementation name in a surfaced service error", async () => {
    render(<ChatPage />);
    await waitFor(() => expect(useChatStore.getState().loading).toBe(false));

    act(() => useChatStore.setState({
      messages: [{ role: "user", content: "测试" }],
      error: "Unexpected Agent transport error",
    }));

    expect(screen.getByRole("alert").textContent).toContain("Unexpected 问答服务 transport error");
    expect(screen.getByRole("alert").textContent).not.toContain("Agent");
  });
});
