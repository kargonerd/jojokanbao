import { create } from "zustand";
import { notebookApi, askStream } from "../api";
import type { RagMessage, RagNotebook, RagSource } from "../types";

function readStoredMessages(value: string | null): RagMessage[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((message): message is RagMessage => (
      typeof message === "object"
      && message !== null
      && (message.role === "user" || message.role === "assistant")
      && typeof message.content === "string"
    ));
  } catch {
    return [];
  }
}

interface ChatState {
  notebooks: RagNotebook[];
  selectedNotebook: string | null;
  sources: RagSource[];
  selectedSourceIds: string[];
  messages: RagMessage[];
  loading: boolean;
  error: string | null;
  streaming: boolean;
  streamContent: string;
  conversationId: string | null;
  loadNotebooks: () => Promise<void>;
  selectNotebook: (id: string) => Promise<void>;
  toggleSource: (id: string) => void;
  sendMessage: (question: string) => void;
  clearConversation: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  notebooks: [],
  selectedNotebook: null,
  sources: [],
  selectedSourceIds: [],
  messages: [],
  loading: false,
  error: null,
  streaming: false,
  streamContent: "",
  conversationId: null,

  loadNotebooks: async () => {
    set({ loading: true, error: null });
    try {
      const notebooks = await notebookApi.list();
      set({ notebooks, loading: false });
      const saved = localStorage.getItem("rag-last-notebook");
      if (saved && notebooks.some((notebook) => notebook.id === saved)) await get().selectNotebook(saved);
      else if (notebooks[0]) await get().selectNotebook(notebooks[0].id);
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : "知识库加载失败" });
    }
  },

  selectNotebook: async (id) => {
    set({ selectedNotebook: id, sources: [], selectedSourceIds: [], messages: [], conversationId: null, loading: true, error: null });
    localStorage.setItem("rag-last-notebook", id);
    try {
      const sources = await notebookApi.getSources(id);
      set({
        sources,
        selectedSourceIds: sources.map((source) => source.id),
        messages: readStoredMessages(localStorage.getItem(`rag-messages-${id}`)),
        loading: false,
      });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : "知识库来源加载失败" });
    }
  },

  toggleSource: (id) => set((s) => ({
    selectedSourceIds: s.selectedSourceIds.includes(id)
      ? s.selectedSourceIds.filter((x) => x !== id)
      : [...s.selectedSourceIds, id],
  })),

  sendMessage: (question) => {
    const { selectedNotebook, selectedSourceIds, messages, conversationId } = get();
    if (!selectedNotebook || !question.trim()) return;
    const newMessages = [...messages, { role: "user" as const, content: question }];
    set({ messages: newMessages, streaming: true, streamContent: "", error: null });

    let content = "";
    askStream(
      { notebook_id: selectedNotebook, question, conversation_id: conversationId || undefined, source_ids: selectedSourceIds },
      (chunk) => { content += chunk; set({ streamContent: content }); },
      (result) => {
        const final = [
          ...newMessages,
          {
            role: "assistant" as const,
            content,
            usage: result.usage,
          },
        ];
        set({
          messages: final,
          streaming: false,
          streamContent: "",
          conversationId: result.conversationId ?? conversationId,
        });
        localStorage.setItem(`rag-messages-${selectedNotebook}`, JSON.stringify(final));
      },
      (err) => {
        const final = [...newMessages, { role: "assistant" as const, content: `错误: ${err}` }];
        set({ messages: final, streaming: false, streamContent: "", error: err });
      }
    );
  },

  clearConversation: () => {
    const { selectedNotebook } = get();
    set({ messages: [], conversationId: null, streamContent: "", error: null });
    if (selectedNotebook) localStorage.removeItem(`rag-messages-${selectedNotebook}`);
  },
}));
