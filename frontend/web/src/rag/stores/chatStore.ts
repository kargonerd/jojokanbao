import { create } from "zustand";
import {
  askStream,
  notebookApi,
} from "../api";
import { localConversationApi } from "../local-conversations";
import { allSourcesSelected, scopeNotebooks, type RagContentType } from "../scope";
import type {
  RagConversationSummary,
  RagMessage,
  RagNotebook,
} from "../types";

const LAST_CONVERSATION_KEY = "rag-last-conversation";

function freshScope(datasetIds: string[], contentType: RagContentType = "all") {
  return {
    contentType,
    selectedNotebookIds: datasetIds,
    messages: [] as RagMessage[],
    conversationId: null,
    streamContent: "",
    streamStatus: "",
    error: null,
  };
}

interface ChatState {
  contentType: RagContentType;
  notebooks: RagNotebook[];
  selectedNotebookIds: string[];
  messages: RagMessage[];
  conversations: RagConversationSummary[];
  loading: boolean;
  historyLoading: boolean;
  error: string | null;
  streaming: boolean;
  streamContent: string;
  streamStatus: string;
  conversationId: string | null;
  loadNotebooks: () => Promise<void>;
  loadConversations: () => Promise<void>;
  openConversation: (conversationId: string) => Promise<void>;
  deleteConversation: (conversationId: string) => Promise<void>;
  selectNotebook: (id: string | null) => void;
  selectContentType: (contentType: RagContentType) => void;
  toggleNotebook: (id: string) => void;
  sendMessage: (question: string) => void;
  clearConversation: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  contentType: "all",
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

  loadNotebooks: async () => {
    set({ loading: true, error: null });
    try {
      const notebooks = await notebookApi.list();
      set({
        notebooks,
        loading: false,
        ...freshScope(scopeNotebooks(notebooks, "all").map((item) => item.id)),
      });
      await get().loadConversations();
      const savedConversation = localStorage.getItem(LAST_CONVERSATION_KEY);
      if (
        savedConversation
        && get().conversations.some((item) => item.id === savedConversation)
      ) {
        await get().openConversation(savedConversation);
      }
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : "书目加载失败",
      });
    }
  },

  loadConversations: async () => {
    set({ historyLoading: true });
    try {
      set({
        conversations: await localConversationApi.list(),
        historyLoading: false,
      });
    } catch {
      set({ historyLoading: false });
    }
  },

  openConversation: async (conversationId) => {
    if (get().streaming || get().historyLoading) return;
    set({
      historyLoading: true,
      error: null,
      messages: [],
      conversationId,
      streamContent: "",
      streamStatus: "",
    });
    try {
      const detail = await localConversationApi.get(conversationId);
      const contentType = detail.conversation.scope?.contentType ?? "book";
      const available = new Set(scopeNotebooks(get().notebooks, contentType).map((item) => item.id));
      const scoped = (detail.conversation.scope?.datasetIds ?? [])
        .filter((id) => available.has(id));
      localStorage.setItem(LAST_CONVERSATION_KEY, conversationId);
      set({
        contentType,
        selectedNotebookIds: detail.conversation.scope?.mode === "all"
          || (!detail.conversation.scope?.mode && !detail.conversation.scope?.datasetIds?.length)
          ? [...available] : scoped,
        messages: detail.messages,
        conversationId,
        streamContent: "",
        streamStatus: "",
        historyLoading: false,
        error: null,
      });
    } catch {
      set({
        historyLoading: false,
        conversationId: null,
        error: "无法打开这条历史记录，请重试。",
      });
    }
  },

  deleteConversation: async (conversationId) => {
    if (get().streaming || get().historyLoading) return;
    set({ historyLoading: true, error: null });
    try {
      await localConversationApi.delete(conversationId);
      const deletingActive = get().conversationId === conversationId;
      if (deletingActive) localStorage.removeItem(LAST_CONVERSATION_KEY);
      set((state) => ({
        conversations: state.conversations.filter((item) => item.id !== conversationId),
        historyLoading: false,
        ...(deletingActive
          ? {
            ...freshScope(scopeNotebooks(state.notebooks, "all").map((item) => item.id)),
          }
          : {}),
      }));
    } catch {
      set({ historyLoading: false });
    }
  },

  selectNotebook: (id) => {
    if (get().streaming || get().historyLoading) return;
    if (id && !scopeNotebooks(get().notebooks, get().contentType).some((item) => item.id === id)) return;
    localStorage.removeItem(LAST_CONVERSATION_KEY);
    const availableIds = scopeNotebooks(get().notebooks, get().contentType).map((item) => item.id);
    set(freshScope(id ? [id] : allSourcesSelected(availableIds, get().selectedNotebookIds) ? [] : availableIds, get().contentType));
  },

  selectContentType: (contentType) => {
    if (get().streaming || get().historyLoading || contentType === get().contentType) return;
    localStorage.removeItem(LAST_CONVERSATION_KEY);
    set(freshScope(scopeNotebooks(get().notebooks, contentType).map((item) => item.id), contentType));
  },

  toggleNotebook: (id) => {
    if (get().streaming || get().historyLoading) return;
    if (!scopeNotebooks(get().notebooks, get().contentType).some((item) => item.id === id)) return;
    localStorage.removeItem(LAST_CONVERSATION_KEY);
    const selectedNotebookIds = get().selectedNotebookIds;
    set(freshScope(
      selectedNotebookIds.includes(id)
        ? selectedNotebookIds.filter((notebookId) => notebookId !== id)
        : [...selectedNotebookIds, id],
      get().contentType,
    ));
  },

  sendMessage: (question) => {
    const {
      notebooks,
      contentType,
      selectedNotebookIds,
      messages,
      conversationId,
      streaming,
      historyLoading,
    } = get();
    const trimmedQuestion = question.trim();
    const availableIds = scopeNotebooks(notebooks, contentType).map((notebook) => notebook.id);
    const datasetIds = selectedNotebookIds.filter((id) => availableIds.includes(id));
    const scopeMode = allSourcesSelected(availableIds, datasetIds) ? "all" : "selected";
    if (!trimmedQuestion || !datasetIds.length || streaming || historyLoading) return;
    const newMessages = [
      ...messages,
      { role: "user" as const, content: trimmedQuestion, createdAt: Date.now() },
    ];
    set({
      messages: newMessages,
      streaming: true,
      streamContent: "",
      streamStatus: "正在准备检索范围…",
      error: null,
    });

    void (async () => {
      let itemIds: string[] | undefined;
      let manifestObjects: string[] | undefined;
      if (contentType === "book" && selectedNotebookIds.length === 1) {
        try {
          const sources = await notebookApi.getSources(selectedNotebookIds[0]!);
          if (sources.length === 1 && sources[0]?.manifestObject) {
            itemIds = [sources[0].itemId ?? sources[0].id];
            manifestObjects = [sources[0].manifestObject];
          }
        } catch {
          // The Agent can still use the remote multi-book search path.
        }
      }

      let content = "";
      askStream(
        {
          contentType,
          datasetIds,
          scopeMode,
          question: trimmedQuestion,
          conversationId: conversationId || undefined,
          itemIds,
          manifestObjects,
          history: messages,
        },
        (chunk) => {
          content += chunk;
          set({ streamContent: content });
        },
        (refs, nextConversationId) => {
          const nextId = nextConversationId ?? conversationId;
          const answeredAt = Date.now();
          const final = [
            ...newMessages,
            { role: "assistant" as const, content, references: refs, createdAt: answeredAt },
          ];
          if (nextId) localStorage.setItem(LAST_CONVERSATION_KEY, nextId);
          if (!nextId) {
            set({
              messages: final,
              streaming: false,
              streamContent: "",
              streamStatus: "",
            });
            return;
          }
          const previous = get().conversations.find((candidate) => candidate.id === nextId);
          const summary: RagConversationSummary = {
            id: nextId,
            title: final.find((message) => message.role === "user")?.content.slice(0, 80) || "新对话",
            createdAt: previous?.createdAt ?? newMessages.at(-1)?.createdAt ?? answeredAt,
            lastMessageAt: answeredAt,
            messageCount: final.length,
            scope: {
              contentType,
              mode: scopeMode,
              datasetIds,
              ...(itemIds ? { itemIds } : {}),
              ...(manifestObjects ? { manifestObjects } : {}),
            },
          };
          set((state) => ({
            messages: final,
            streaming: false,
            streamContent: "",
            streamStatus: "",
            conversationId: nextId,
            conversations: [
              summary,
              ...state.conversations.filter((candidate) => candidate.id !== nextId),
            ],
          }));
          void localConversationApi.put({ conversation: summary, messages: final }).catch(() => {
            set({ error: "回答已完成，但未能保存到本机历史记录。" });
          });
        },
        (err) => {
          set({ streaming: false, streamContent: "", streamStatus: "", error: err });
        },
        (activity) => set({ streamStatus: activity.message }),
      );
    })();
  },

  clearConversation: () => {
    if (get().streaming || get().historyLoading) return;
    localStorage.removeItem(LAST_CONVERSATION_KEY);
    set(freshScope(scopeNotebooks(get().notebooks, "all").map((item) => item.id)));
  },
}));
