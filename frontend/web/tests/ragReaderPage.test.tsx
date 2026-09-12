import { StrictMode, type ReactNode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JojoFragment } from "@jojo/content";
import type { LoadedItem } from "../src/rag/content";
import { ReaderPage } from "../src/rag/pages/ReaderPage";
import { useAccountSessionStore } from "../src/account/session";

interface ReaderProps {
  activeChapterId: string;
  contentLoading: boolean;
  error: string;
  children: ReactNode;
  speechControl: ReactNode;
  loadChapter: (chapterId: string, signal: AbortSignal) => Promise<ReactNode>;
  onVisibleChapterChange: (chapterId: string) => void;
  onChapterChange: (chapterId: string) => void;
}

const mocks = vi.hoisted(() => ({
  loadItem: vi.fn(), loadFragment: vi.fn(), loadAssetUrl: vi.fn(),
  prefetchBookChapters: vi.fn(), readerProps: [] as ReaderProps[],
}));

vi.mock("../src/rag/content", () => ({
  loadItem: mocks.loadItem,
  loadFragment: mocks.loadFragment,
  loadAssetUrl: mocks.loadAssetUrl,
  prefetchBookChapters: mocks.prefetchBookChapters,
  loadBookCoverUrl: async () => undefined,
  searchLoadedBook: async () => [],
  downloadExport: async () => undefined,
}));

vi.mock("../src/rag/components/BookReader", () => ({
  BookReader: (props: ReaderProps) => {
    mocks.readerProps.push(props);
    return <main>{props.children}{props.speechControl}</main>;
  },
}));

vi.mock("../src/reading/SpeechPlayer", () => ({
  SpeechPlayer: ({ title }: { title: string }) => <output data-testid="speech-title">{title}</output>,
}));

const loaded = {
  entry: { datasetId: "example", type: "book", title: "示例书", language: "zh-CN", indexObject: "example/index.jox" },
  index: { datasetId: "example", items: [] },
  item: { itemId: "example:book", itemKey: "book", title: "示例书" },
  manifestObject: "example/manifest.jox",
  manifest: {
    datasetId: "example", itemId: "example:book", title: "示例书",
    content: { chapters: [
      { id: "one", title: "第一章", order: 1, characterCount: 100 },
      { id: "two", title: "第二章", order: 2, characterCount: 100 },
      { id: "three", title: "第三章", order: 3, characterCount: 100 },
    ], toc: [] },
    contentStats: { characterCount: 300, chapterCount: 3 }, exports: [],
    assets: [
      { id: "shared", type: "image" },
      { id: "one-image", type: "image" },
      { id: "two-image", type: "image" },
      { id: "audio", type: "audio" },
      { id: "video", type: "video" },
    ],
  },
} as unknown as LoadedItem;

function fragment(chapterId: string): JojoFragment {
  return {
    formatVersion: "jojo-fragment/1", itemId: "example:book", fragmentId: chapterId,
    type: "chapter", order: 1, title: chapterId === "one" ? "第一章" : chapterId === "two" ? "第二章" : "第三章",
    body: { format: "html", value: `<p>${chapterId} 的正文<sup data-annotation-id="note"></sup></p><figure data-asset-id="shared"></figure><figure data-asset-id="${chapterId}-image"></figure>` },
    annotations: [{ id: "note", targetId: chapterId, kind: "footnote", label: "1", body: { format: "text", value: `${chapterId} 的注释` } }],
    assetRefs: ["shared", `${chapterId}-image`, ...(chapterId === "one" ? ["audio", "video"] : [])],
  };
}

function currentReader() { return mocks.readerProps.at(-1)!; }
function renderReader(chapter = "one", strict = false) {
  const reader = <MemoryRouter initialEntries={[`/book/example/book?chapter=${chapter}`]}>
    <Routes><Route path="/book/:notebookId/:sourceId" element={<ReaderPage />} /></Routes>
  </MemoryRouter>;
  return render(strict ? <StrictMode>{reader}</StrictMode> : reader);
}

beforeEach(() => {
  mocks.readerProps.length = 0;
  mocks.loadItem.mockReset().mockResolvedValue(loaded);
  mocks.loadFragment.mockReset().mockImplementation(async (_loaded: LoadedItem, chapterId: string) => fragment(chapterId));
  mocks.loadAssetUrl.mockReset().mockImplementation(async (_loaded: LoadedItem, assetId: string) => `blob:${assetId}`);
  mocks.prefetchBookChapters.mockReset().mockResolvedValue(undefined);
  useAccountSessionStore.setState({ initialized: true, userId: "reader-1", displayName: "读者" });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("book ReaderPage chapter sessions", () => {
  it("opens chapters normally after StrictMode replays mount cleanup", async () => {
    const view = renderReader("one", true);
    await screen.findByRole("heading", { name: "第一章" });
    expect(currentReader().contentLoading).toBe(false);
    expect(currentReader().error).toBe("");
    const node = await currentReader().loadChapter("two", new AbortController().signal);
    expect(node).toBeTruthy();
    act(() => currentReader().onVisibleChapterChange("two"));
    expect(screen.getByRole("heading", { name: "第二章" })).toBeTruthy();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:two-image");
  });

  it("retains stable neighboring content and shared assets while synchronizing the visible chapter", async () => {
    const view = renderReader();
    await screen.findByRole("heading", { name: "第一章" });
    const firstContent = currentReader().children;
    const loader = currentReader().loadChapter;
    const signal = new AbortController().signal;
    const [second, sameSecond] = await Promise.all([loader("two", signal), loader("two", signal)]);
    expect(second).toBe(sameSecond);
    expect(currentReader().activeChapterId).toBe("one");
    expect(mocks.loadFragment).toHaveBeenCalledTimes(2);
    expect(mocks.loadAssetUrl.mock.calls.filter(([, id]) => id === "shared")).toHaveLength(1);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    const previousRenderCount = mocks.readerProps.length;
    act(() => currentReader().onVisibleChapterChange("two"));
    expect(currentReader().activeChapterId).toBe("two");
    expect(currentReader().children).toBe(second);
    expect(screen.getByTestId("speech-title").textContent).toBe("第二章");
    expect(mocks.readerProps.slice(previousRenderCount).every((props) => !props.contentLoading)).toBe(true);
    expect(await currentReader().loadChapter("one", signal)).toBe(firstContent);
    act(() => currentReader().onChapterChange("one"));
    expect(currentReader().children).toBe(firstContent);
    expect(mocks.loadFragment).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:one-image");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:two-image");
    expect(vi.mocked(URL.revokeObjectURL).mock.calls.filter(([url]) => url === "blob:shared")).toHaveLength(1);
  });

  it("keeps chapter notes, original anchors, audio and video in the reusable content", async () => {
    renderReader();
    await screen.findByRole("heading", { name: "第一章" });
    expect(screen.getByRole("link", { name: "查看注释 1" }).getAttribute("href")).toBe("#note");
    expect(screen.getByRole("link", { name: "返回正文脚注标记" }).getAttribute("href")).toBe("#annotation-ref-note");
    expect(document.getElementById("note")?.textContent).toContain("one 的注释");
    expect(document.querySelector("audio")?.getAttribute("src")).toBe("blob:audio");
    expect(document.querySelector("video")?.getAttribute("src")).toBe("blob:video");
  });

  it("retries failed neighboring chapters without clearing the visible chapter", async () => {
    renderReader();
    await screen.findByRole("heading", { name: "第一章" });
    mocks.loadFragment.mockRejectedValueOnce(new Error("offline"));
    const signal = new AbortController().signal;
    await expect(currentReader().loadChapter("two", signal)).rejects.toThrow("offline");
    expect(currentReader().activeChapterId).toBe("one");
    expect(currentReader().contentLoading).toBe(false);
    expect(await currentReader().loadChapter("two", signal)).toBeTruthy();
    expect(mocks.loadFragment).toHaveBeenCalledTimes(3);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it("cancels a subscriber without discarding another request for the same chapter", async () => {
    renderReader();
    await screen.findByRole("heading", { name: "第一章" });
    let finish!: (value: JojoFragment) => void;
    mocks.loadFragment.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const controller = new AbortController();
    const abandoned = currentReader().loadChapter("two", controller.signal);
    const retained = currentReader().loadChapter("two", new AbortController().signal);
    controller.abort();
    await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
    finish(fragment("two"));
    expect(await retained).toBeTruthy();
    expect(mocks.loadFragment).toHaveBeenCalledTimes(2);
    expect(currentReader().activeChapterId).toBe("one");
  });

  it("releases resolved assets and rejects late chapter content when the book closes", async () => {
    const view = renderReader();
    await screen.findByRole("heading", { name: "第一章" });
    let finishAsset!: (value: string) => void;
    mocks.loadAssetUrl.mockImplementationOnce(() => new Promise((resolve) => { finishAsset = resolve; }));
    const pending = currentReader().loadChapter("two", new AbortController().signal);
    await waitFor(() => expect(finishAsset).toBeDefined());
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:one-image");
    finishAsset("blob:late-two");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:late-two");
  });

  it("discards cached chapters when the reader identity changes", async () => {
    renderReader();
    await screen.findByRole("heading", { name: "第一章" });
    const previousLoader = currentReader().loadChapter;
    act(() => useAccountSessionStore.setState({ userId: "reader-2" }));
    await waitFor(() => expect(mocks.loadItem).toHaveBeenCalledTimes(2));
    await screen.findByRole("heading", { name: "第一章" });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:one-image");
    expect(mocks.loadFragment.mock.calls.filter(([, id]) => id === "one")).toHaveLength(2);
    await expect(previousLoader("two", new AbortController().signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
