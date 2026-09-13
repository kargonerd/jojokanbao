import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analytics } from "@jojo/analytics";
import type { JojoFragment } from "@jojo/content";
import { useAccountSessionStore } from "../src/account/session";
import type { LoadedItem } from "../src/rag/content";
import { ReaderPage } from "../src/rag/pages/ReaderPage";

const content = vi.hoisted(() => ({
  loadItem: vi.fn(), loadFragment: vi.fn(), loadBookCoverUrl: vi.fn(),
  loadAssetUrl: vi.fn(), prefetchBookChapters: vi.fn(), searchLoadedBook: vi.fn(), downloadExport: vi.fn(),
}));
vi.mock("../src/rag/content", () => content);
vi.mock("../src/rag/components/BookReader", () => ({
  BookReader: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock("../src/reading/SpeechPlayer", () => ({ SpeechPlayer: () => null }));

function book(itemKey: string): LoadedItem {
  return {
    entry: { access: "public" }, index: { items: [] }, item: { itemKey }, manifestObject: "book.jox",
    manifest: {
      datasetId: "books", itemId: itemKey, title: itemKey, access: "public",
      content: { chapters: [{ id: "chapter-1", title: "Chapter" }], toc: [] },
      contentStats: { characterCount: 4 }, assets: [], exports: [],
    },
  } as unknown as LoadedItem;
}

beforeEach(() => {
  vi.clearAllMocks();
  useAccountSessionStore.setState({ initialized: true, userId: null, displayName: null });
  content.loadBookCoverUrl.mockResolvedValue(undefined);
  content.prefetchBookChapters.mockResolvedValue(undefined);
  content.loadFragment.mockImplementation(async (item: LoadedItem): Promise<JojoFragment> => ({
    formatVersion: "jojo-fragment/1", itemId: item.manifest.itemId, fragmentId: "chapter-1",
    type: "chapter", order: 1, title: "Chapter", assetRefs: [], annotations: [],
    body: { format: "html", profile: "jojo-semantic-html/1", value: "<p>Body</p>" },
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("book reading analytics across route changes", () => {
  it.each(["reading_loaded", "reading_failed"] as const)("does not reuse the previous book's %s state", async (firstEvent) => {
    const track = vi.spyOn(analytics, "track").mockImplementation(() => undefined);
    let resolveNext!: (value: LoadedItem) => void;
    const next = new Promise<LoadedItem>((resolve) => { resolveNext = resolve; });
    content.loadItem.mockImplementation((_datasetId: string, itemKey: string) => {
      if (itemKey === "second") return next;
      return firstEvent === "reading_loaded" ? Promise.resolve(book(itemKey)) : Promise.reject(new Error("Cannot load first book"));
    });
    render(<MemoryRouter initialEntries={["/book/books/first"]}>
      <Link to="/book/books/second">Next book</Link>
      <Routes><Route path="/book/:notebookId/:sourceId" element={<ReaderPage />} /></Routes>
    </MemoryRouter>);
    await waitFor(() => expect(track).toHaveBeenCalledWith(firstEvent, expect.objectContaining({ content_id: "books:first" })));
    track.mockClear();

    fireEvent.click(screen.getByRole("link", { name: "Next book" }));
    await waitFor(() => expect(content.loadItem).toHaveBeenCalledWith("books", "second"));
    expect(track).not.toHaveBeenCalled();

    await act(async () => { resolveNext(book("second")); await next; });
    await waitFor(() => expect(track).toHaveBeenCalledWith("reading_loaded", expect.objectContaining({ content_id: "books:second" })));
    expect(track).toHaveBeenCalledTimes(1);
  });
});
