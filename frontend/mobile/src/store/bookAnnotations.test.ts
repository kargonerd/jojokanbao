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

it.each([undefined, true, false])("preserves the complete thought when removing its mark (underlined=%s)", (underlined) => {
  const selected: BookAnnotation = { ...note, ownerId: "reader", note: "  保留原来的想法和空格  ", underlined, prefix: "前文", suffix: "后文" };
  const previous = { ...note, id: "previous", chapterId: "c0" };
  const otherBook = { ...note, id: "other-book", itemKey: "another" };
  const otherAccount = { ...note, id: "other-account", ownerId: "someone" };
  useMobileStore.setState({ bookAnnotations: [previous, selected, otherBook, otherAccount] });
  useMobileStore.getState().removeBookAnnotationMark(selected.id);
  const result = useMobileStore.getState().bookAnnotations;
  expect(result).toEqual([previous, { ...selected, underlined: false }, otherBook, otherAccount]);
  expect(result[0]).toBe(previous);
  expect(result[2]).toBe(otherBook);
  expect(result[3]).toBe(otherAccount);
  expect(selected.underlined).toBe(underlined);
  useMobileStore.getState().removeBookAnnotationMark(selected.id);
  expect(useMobileStore.getState().bookAnnotations).toEqual(result);
});

it.each([undefined, "", " \n\t "])("removes only the selected record when it has no thought (%j)", (body) => {
  const selected = { ...note, note: body, underlined: true };
  const unrelated = { ...note, id: "other", note: "保留这条想法" };
  useMobileStore.setState({ bookAnnotations: [selected, unrelated] });
  useMobileStore.getState().removeBookAnnotationMark(selected.id);
  expect(useMobileStore.getState().bookAnnotations).toEqual([unrelated]);
  expect(useMobileStore.getState().bookAnnotations[0]).toBe(unrelated);
  useMobileStore.getState().removeBookAnnotationMark(selected.id);
  expect(useMobileStore.getState().bookAnnotations).toEqual([unrelated]);
});

it("leaves all annotations unchanged when the mark is already missing", () => {
  const annotations = [note, { ...note, id: "other", note: undefined }];
  useMobileStore.setState({ bookAnnotations: annotations });
  useMobileStore.getState().removeBookAnnotationMark("unknown");
  expect(useMobileStore.getState().bookAnnotations).toEqual(annotations);
  expect(useMobileStore.getState().bookAnnotations.every((annotation, index) => annotation === annotations[index])).toBe(true);
});
