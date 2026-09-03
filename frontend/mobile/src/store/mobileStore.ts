import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ArchivePublicationName } from "@jojo/content";
import type { BookReadingMode } from "../lib/bookReaderBridge";
import type { MobileBookAgentMessage } from "../lib/bookAgent";

export type BookPaperColor = "ivory" | "white" | "dark";

export interface BookAnnotation {
  id: string;
  datasetId: string;
  itemKey: string;
  chapterId: string;
  chapterTitle: string;
  start: number;
  end: number;
  quote: string;
  note?: string;
  createdAt: number;
}

type BookAnnotationInput = Omit<BookAnnotation, "id" | "createdAt">;

export interface RecentIssue {
  publication: ArchivePublicationName;
  issueId: string;
  title: string;
  subtitle: string;
  currentPage: number;
  totalPages: number;
  progress: number;
  updatedAt: number;
}

export interface RecentBook {
  datasetId: string;
  itemKey: string;
  title: string;
  subtitle: string;
  progress: number;
  chapterId?: string;
  spreadIndex?: number;
  scrollProgress?: number;
  updatedAt: number;
}

export interface MobileAiConversation {
  id: string;
  ownerId: string;
  title: string;
  createdAt: number;
  lastMessageAt: number;
  selectedDatasetIds: string[];
  messages: MobileBookAgentMessage[];
}

interface RememberIssueInput extends Omit<RecentIssue, "progress" | "updatedAt"> {}

interface MobileState {
  hapticsEnabled: boolean;
  textScale: 0.9 | 1 | 1.12;
  bookLineHeight: 1.75 | 1.95 | 2.15;
  bookReadingMode: BookReadingMode;
  bookPaperColor: BookPaperColor;
  bookFirstLineIndent: boolean;
  keepScreenAwake: boolean;
  allowLandscape: boolean;
  leftTapNext: boolean;
  recentIssues: RecentIssue[];
  recentBooks: RecentBook[];
  bookAnnotations: BookAnnotation[];
  aiConversations: MobileAiConversation[];
  timesLanguage: "zh-CN" | "original";
  timesReadArticleIds: string[];
  timesDisabledSourceIds: string[];
  setHapticsEnabled: (enabled: boolean) => void;
  setTextScale: (scale: MobileState["textScale"]) => void;
  setBookLineHeight: (lineHeight: MobileState["bookLineHeight"]) => void;
  setBookReadingMode: (mode: BookReadingMode) => void;
  setBookPaperColor: (color: BookPaperColor) => void;
  setBookFirstLineIndent: (enabled: boolean) => void;
  setKeepScreenAwake: (enabled: boolean) => void;
  setAllowLandscape: (enabled: boolean) => void;
  setLeftTapNext: (enabled: boolean) => void;
  rememberIssue: (issue: RememberIssueInput) => void;
  rememberBook: (book: Omit<RecentBook, "updatedAt">) => void;
  addBookAnnotation: (annotation: BookAnnotationInput) => BookAnnotation;
  updateBookAnnotationNote: (id: string, note: string) => void;
  removeBookAnnotation: (id: string) => void;
  upsertAiConversation: (conversation: MobileAiConversation) => void;
  removeAiConversation: (id: string, ownerId: string) => void;
  setTimesLanguage: (language: MobileState["timesLanguage"]) => void;
  setTimesSourceEnabled: (sourceId: string, enabled: boolean, availableSourceIds: string[]) => boolean;
  setAllTimesSourcesEnabled: (enabled: boolean, availableSourceIds: string[]) => void;
  enableAllTimesSources: () => void;
  markTimesArticleRead: (articleId: string) => void;
  clearRecentIssues: () => void;
  clearRecentReading: () => void;
}

export const useMobileStore = create<MobileState>()(
  persist(
    (set) => ({
      hapticsEnabled: true,
      textScale: 1,
      bookLineHeight: 1.95,
      bookReadingMode: "paged",
      bookPaperColor: "ivory",
      bookFirstLineIndent: true,
      keepScreenAwake: true,
      allowLandscape: true,
      leftTapNext: false,
      recentIssues: [],
      recentBooks: [],
      bookAnnotations: [],
      aiConversations: [],
      timesLanguage: "zh-CN",
      timesReadArticleIds: [],
      timesDisabledSourceIds: [],
      setHapticsEnabled: (hapticsEnabled) => set({ hapticsEnabled }),
      setTextScale: (textScale) => set({ textScale }),
      setBookLineHeight: (bookLineHeight) => set({ bookLineHeight }),
      setBookReadingMode: (bookReadingMode) => set({ bookReadingMode }),
      setBookPaperColor: (bookPaperColor) => set({ bookPaperColor }),
      setBookFirstLineIndent: (bookFirstLineIndent) => set({ bookFirstLineIndent }),
      setKeepScreenAwake: (keepScreenAwake) => set({ keepScreenAwake }),
      setAllowLandscape: (allowLandscape) => set({ allowLandscape }),
      setLeftTapNext: (leftTapNext) => set({ leftTapNext }),
      rememberIssue: (issue) => set((state) => {
        const currentPage = Math.max(1, Math.floor(issue.currentPage || 1));
        const totalPages = Math.max(0, Math.floor(issue.totalPages || 0));
        const progress = totalPages > 0 ? Math.min(100, Math.round((currentPage / totalPages) * 100)) : 0;
        const entry: RecentIssue = { ...issue, currentPage, totalPages, progress, updatedAt: Date.now() };
        return {
          recentIssues: [
            entry,
            ...state.recentIssues.filter((candidate) => (
              candidate.publication !== issue.publication || candidate.issueId !== issue.issueId
            )),
          ].slice(0, 8),
        };
      }),
      rememberBook: (book) => set((state) => {
        const entry: RecentBook = {
          ...book,
          progress: Math.max(0, Math.min(100, Math.round(book.progress || 0))),
          spreadIndex: typeof book.spreadIndex === "number"
            ? Math.max(0, Math.floor(book.spreadIndex))
            : undefined,
          scrollProgress: typeof book.scrollProgress === "number"
            ? Math.max(0, Math.min(1, book.scrollProgress))
            : undefined,
          updatedAt: Date.now(),
        };
        return {
          recentBooks: [
            entry,
            ...state.recentBooks.filter((candidate) => (
              candidate.datasetId !== book.datasetId || candidate.itemKey !== book.itemKey
            )),
          ].slice(0, 8),
        };
      }),
      addBookAnnotation: (annotation) => {
        const created: BookAnnotation = {
          ...annotation,
          id: `annotation_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          createdAt: Date.now(),
        };
        set((state) => ({ bookAnnotations: [created, ...state.bookAnnotations] }));
        return created;
      },
      updateBookAnnotationNote: (id, note) => set((state) => ({
        bookAnnotations: state.bookAnnotations.map((annotation) => (
          annotation.id === id ? { ...annotation, note: note.trim() || undefined } : annotation
        )),
      })),
      removeBookAnnotation: (id) => set((state) => ({
        bookAnnotations: state.bookAnnotations.filter((annotation) => annotation.id !== id),
      })),
      upsertAiConversation: (conversation) => set((state) => ({
        aiConversations: [
          conversation,
          ...state.aiConversations.filter((candidate) => (
            candidate.id !== conversation.id || candidate.ownerId !== conversation.ownerId
          )),
        ]
          .sort((left, right) => right.lastMessageAt - left.lastMessageAt)
          .slice(0, 30),
      })),
      removeAiConversation: (id, ownerId) => set((state) => ({
        aiConversations: state.aiConversations.filter((candidate) => (
          candidate.id !== id || candidate.ownerId !== ownerId
        )),
      })),
      setTimesLanguage: (timesLanguage) => set({ timesLanguage }),
      setTimesSourceEnabled: (sourceId, enabled, availableSourceIds) => {
        let changed = false;
        set((state) => {
          const disabled = new Set(state.timesDisabledSourceIds);
          if (enabled) {
            changed = disabled.delete(sourceId);
          } else {
            const enabledCount = availableSourceIds.filter((id) => !disabled.has(id)).length;
            if (enabledCount <= 1 || disabled.has(sourceId)) return state;
            disabled.add(sourceId);
            changed = true;
          }
          return changed ? { timesDisabledSourceIds: [...disabled] } : state;
        });
        return changed;
      },
      setAllTimesSourcesEnabled: (enabled, availableSourceIds) => set({
        timesDisabledSourceIds: enabled ? [] : availableSourceIds.slice(1),
      }),
      enableAllTimesSources: () => set({ timesDisabledSourceIds: [] }),
      markTimesArticleRead: (articleId) => set((state) => ({
        timesReadArticleIds: [
          ...state.timesReadArticleIds.filter((candidate) => candidate !== articleId),
          articleId,
        ].slice(-500),
      })),
      clearRecentIssues: () => set({ recentIssues: [] }),
      clearRecentReading: () => set({ recentIssues: [], recentBooks: [] }),
    }),
    {
      name: "jojo-mobile-preferences-v1",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: ({ hapticsEnabled, textScale, bookLineHeight, bookReadingMode, bookPaperColor, bookFirstLineIndent, keepScreenAwake, allowLandscape, leftTapNext, recentIssues, recentBooks, bookAnnotations, aiConversations, timesLanguage, timesReadArticleIds, timesDisabledSourceIds }) => ({
        hapticsEnabled,
        textScale,
        bookLineHeight,
        bookReadingMode,
        bookPaperColor,
        bookFirstLineIndent,
        keepScreenAwake,
        allowLandscape,
        leftTapNext,
        recentIssues,
        recentBooks,
        bookAnnotations,
        aiConversations,
        timesLanguage,
        timesReadArticleIds,
        timesDisabledSourceIds,
      }),
    },
  ),
);
