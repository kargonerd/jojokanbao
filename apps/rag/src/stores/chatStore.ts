import { create } from "zustand";
import { notebookApi, askStream } from "../api";

interface Message { role: "user" | "assistant"; content: string; references?: any[] }

interface ChatState {
  notebooks: any[];
  selectedNotebook: string | null;
  sources: any[];
  selectedSourceIds: string[];
  messages: Message[];
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
  streaming: false,
  streamContent: "",
  conversationId: null,

  loadNotebooks: async () => {
    const notebooks = await notebookApi.list();
    set({ notebooks });
    const saved = localStorage.getItem("rag-last-notebook");
    if (saved && notebooks.find((n: any) => n.id === saved)) get().selectNotebook(saved);
    else if (notebooks.length) get().selectNotebook(notebooks[0].id);
  },

  selectNotebook: async (id) => {
    set({ selectedNotebook: id, sources: [], selectedSourceIds: [], messages: [], conversationId: null });
    localStorage.setItem("rag-last-notebook", id);
    const sources = await notebookApi.getSources(id);
    set({ sources, selectedSourceIds: sources.map((s: any) => s.id) });
    // Restore messages from localStorage
    const saved = localStorage.getItem(`rag-messages-${id}`);
    if (saved) try { set({ messages: JSON.parse(saved) }); } catch {}
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
    set({ messages: newMessages, streaming: true, streamContent: "" });

    let content = "";
    askStream(
      { notebook_id: selectedNotebook, question, conversation_id: conversationId || undefined, source_ids: selectedSourceIds },
      (chunk) => { content += chunk; set({ streamContent: content }); },
      (refs) => {
        const final = [...newMessages, { role: "assistant" as const, content, references: refs }];
        set({ messages: final, streaming: false, streamContent: "" });
        localStorage.setItem(`rag-messages-${selectedNotebook}`, JSON.stringify(final));
      },
      (err) => {
        const final = [...newMessages, { role: "assistant" as const, content: `错误: ${err}` }];
        set({ messages: final, streaming: false, streamContent: "" });
      }
    );
  },

  clearConversation: () => {
    const { selectedNotebook } = get();
    set({ messages: [], conversationId: null, streamContent: "" });
    if (selectedNotebook) localStorage.removeItem(`rag-messages-${selectedNotebook}`);
  },
}));
