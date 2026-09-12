import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: vi.fn(async () => undefined), removeItem: vi.fn() } }));
import { useMobileStore, type BookAnnotation } from "./mobileStore";

beforeEach(() => useMobileStore.setState({ bookAnnotations: [] }));
const note: BookAnnotation = { id: "legacy", datasetId: "books", itemKey: "book", chapterId: "c1", chapterTitle: "第一章", start: 0, end: 2, quote: "原文", note: "旧想法", createdAt: 1 };

it("only claims unowned legacy notes for the chosen book and preserves their content", () => {
  useMobileStore.setState({ bookAnnotations: [note, { ...note, id: "other-account", ownerId: "someone" }, { ...note, id: "other-book", itemKey: "another" }, { ...note, id: "guest", ownerId: null }] });
  useMobileStore.getState().claimLegacyBookAnnotations("books", "book", "reader");
  expect(useMobileStore.getState().bookAnnotations).toEqual([
    { ...note, ownerId: "reader" }, { ...note, id: "other-account", ownerId: "someone" }, { ...note, id: "other-book", itemKey: "another" }, { ...note, id: "guest", ownerId: "reader" },
  ]);
  useMobileStore.getState().claimLegacyBookAnnotations("books", "book", "second-reader");
  expect(useMobileStore.getState().bookAnnotations[0]?.ownerId).toBe("reader");
});
