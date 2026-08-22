import { create } from "zustand";
import { askStream, notebookApi } from "../api";
import type { RagMessage, RagNotebook } from "../types";

export type ChatScopeMode = "single" | "multiple";

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

function scopeStorageKey(datasetIds: string[]): string | null {
  if (!datasetIds.length) return null;
  return `rag-messages-${[...datasetIds].sort().join(",")}`;
}

function restoredScope(datasetIds: string[]) {
  const storageKey = scopeStorageKey(datasetIds);
  return {
    selectedNotebookIds: datasetIds,
    messages: readStoredMessages(storageKey ? localStorage.getItem(storageKey) : null),
    conversationId: null,
    streamContent: "",
    error: null,
  };
}

interface ChatState {
  notebooks: RagNotebook[];
  selectedNotebookIds: string[];
  scopeMode: ChatScopeMode;
  messages: RagMessage[];
  loading: boolean;
  error: string | null;
  streaming: boolean;
  streamContent: string;
  conversationId: string | null;
  loadNotebooks: () => Promise<void>;
  selectNotebook: (id: string) => void;
  toggleNotebook: (id: string) => void;
  setScopeMode: (mode: ChatScopeMode) => void;
  sendMessage: (question: string) => void;
  clearConversation: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  notebooks: [],
  selectedNotebookIds: [],
  scopeMode: "single",
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
      const saved = localStorage.getItem("rag-last-notebook");
      const initial = notebooks.find((notebook) => notebook.id === saved) ?? notebooks[0];
      set({
        notebooks,
        loading: false,
        ...(initial ? restoredScope([initial.id]) : restoredScope([])),
      });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : "书目加载失败" });
    }
  },

  selectNotebook: (id) => {
    localStorage.setItem("rag-last-notebook", id);
    set({ scopeMode: "single", ...restoredScope([id]) });
  },

  toggleNotebook: (id) => set((state) => {
    const selectedNotebookIds = state.selectedNotebookIds.includes(id)
      ? state.selectedNotebookIds.filter((candidate) => candidate !== id)
      : [...state.selectedNotebookIds, id];
    const lastSelectedNotebookId = selectedNotebookIds.at(-1);
    if (lastSelectedNotebookId) localStorage.setItem("rag-last-notebook", lastSelectedNotebookId);
    return restoredScope(selectedNotebookIds);
  }),

  setScopeMode: (scopeMode) => set((state) => {
    if (scopeMode === state.scopeMode) return {};
    const selectedNotebookIds = scopeMode === "single"
      ? [state.selectedNotebookIds[0] ?? state.notebooks[0]?.id].filter((id): id is string => Boolean(id))
      : state.selectedNotebookIds;
    if (scopeMode === "single" && selectedNotebookIds[0]) {
      localStorage.setItem("rag-last-notebook", selectedNotebookIds[0]);
    }
    return { scopeMode, ...restoredScope(selectedNotebookIds) };
  }),

  sendMessage: (question) => {
    const { selectedNotebookIds, messages, conversationId, streaming } = get();
    if (!selectedNotebookIds.length || !question.trim() || streaming) return;
    const newMessages = [...messages, { role: "user" as const, content: question }];
    set({ messages: newMessages, streaming: true, streamContent: "", error: null });

    let content = "";
    askStream(
      { datasetIds: selectedNotebookIds, question, conversationId: conversationId || undefined },
      (chunk) => { content += chunk; set({ streamContent: content }); },
      (refs, nextConversationId) => {
        const final = [...newMessages, { role: "assistant" as const, content, references: refs }];
        set({ messages: final, streaming: false, streamContent: "", conversationId: nextConversationId ?? conversationId });
        const storageKey = scopeStorageKey(selectedNotebookIds);
        if (storageKey) localStorage.setItem(storageKey, JSON.stringify(final));
      },
      (err) => {
        const final = [...newMessages, { role: "assistant" as const, content: `错误: ${err}` }];
        set({ messages: final, streaming: false, streamContent: "", error: err });
      },
    );
  },

  clearConversation: () => {
    const { selectedNotebookIds } = get();
    set({ messages: [], conversationId: null, streamContent: "", error: null });
    const storageKey = scopeStorageKey(selectedNotebookIds);
    if (storageKey) localStorage.removeItem(storageKey);
  },
}));
