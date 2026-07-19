import { create } from "zustand";
import {
  askStream,
  documentApi,
  type CitationReference,
  type DocumentSummary,
  type UsageSummary,
} from "../api";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  references?: CitationReference[];
  usage?: UsageSummary;
  traces?: string[];
}

interface ChatState {
  documents: DocumentSummary[];
  selectedDocumentIds: string[];
  messages: ChatMessage[];
  streaming: boolean;
  streamContent: string;
  streamStatus: string;
  streamTraces: string[];
  loadDocuments: () => Promise<void>;
  toggleDocument: (id: string) => void;
  sendMessage: (question: string) => void;
  clearConversation: () => void;
}

const MESSAGES_KEY = "jojo-rag-agent-messages";
const SELECTION_KEY = "jojo-rag-agent-documents";

function storedMessages(): ChatMessage[] {
  try {
    return JSON.parse(localStorage.getItem(MESSAGES_KEY) || "[]") as ChatMessage[];
  } catch {
    return [];
  }
}

export const useChatStore = create<ChatState>((set, get) => ({
  documents: [],
  selectedDocumentIds: [],
  messages: storedMessages(),
  streaming: false,
  streamContent: "",
  streamStatus: "",
  streamTraces: [],

  loadDocuments: async () => {
    const documents = await documentApi.list();
    let savedIds: string[] = [];
    try {
      savedIds = JSON.parse(localStorage.getItem(SELECTION_KEY) || "[]") as string[];
    } catch {
      savedIds = [];
    }
    const availableIds = new Set(documents.map((document) => document.id));
    const selectedDocumentIds = savedIds.filter((id) => availableIds.has(id));
    if (selectedDocumentIds.length === 0 && documents[0]) selectedDocumentIds.push(documents[0].id);
    localStorage.setItem(SELECTION_KEY, JSON.stringify(selectedDocumentIds));
    set({ documents, selectedDocumentIds });
  },

  toggleDocument: (id) => {
    const selected = get().selectedDocumentIds;
    const selectedDocumentIds = selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id];
    localStorage.setItem(SELECTION_KEY, JSON.stringify(selectedDocumentIds));
    set({ selectedDocumentIds });
  },

  sendMessage: (question) => {
    const { selectedDocumentIds, messages } = get();
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion || selectedDocumentIds.length === 0 || get().streaming) return;

    const nextMessages: ChatMessage[] = [...messages, { role: "user", content: trimmedQuestion }];
    let content = "";
    let usage: UsageSummary | undefined;
    let references: CitationReference[] = [];
    let traces: string[] = [];
    let finalized = false;
    set({
      messages: nextMessages,
      streaming: true,
      streamContent: "",
      streamStatus: "正在连接 Agent…",
      streamTraces: [],
    });

    const finish = (error?: string) => {
      if (finalized) return;
      finalized = true;
      const assistant: ChatMessage = error
        ? { role: "assistant", content: `问答失败：${error}`, traces }
        : {
            role: "assistant",
            content,
            references,
            traces,
            ...(usage ? { usage } : {}),
          };
      const finalMessages = [...nextMessages, assistant];
      localStorage.setItem(MESSAGES_KEY, JSON.stringify(finalMessages));
      set({
        messages: finalMessages,
        streaming: false,
        streamContent: "",
        streamStatus: "",
        streamTraces: [],
      });
    };

    askStream(
      {
        question: trimmedQuestion,
        documentIds: selectedDocumentIds,
        history: messages.slice(-6).map(({ role, content: historyContent }) => ({ role, content: historyContent })),
      },
      (event) => {
        if (event.type === "status") set({ streamStatus: event.message });
        if (event.type === "trace") {
          traces = [...traces, event.message];
          set({ streamTraces: traces, streamStatus: event.message });
        }
        if (event.type === "chunk") {
          content += event.content;
          set({ streamContent: content });
        }
        if (event.type === "usage") usage = event.usage;
        if (event.type === "done") {
          references = event.references;
          finish();
        }
        if (event.type === "error") finish(event.message);
      },
      (error) => finish(error),
    );
  },

  clearConversation: () => {
    localStorage.removeItem(MESSAGES_KEY);
    set({ messages: [], streamContent: "", streamStatus: "", streamTraces: [] });
  },
}));
