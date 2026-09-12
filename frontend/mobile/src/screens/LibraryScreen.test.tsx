import { ARCHIVE_PUBLICATIONS, getLatestRmrbAvailableDate } from "@jojo/content";
import { type ComponentProps, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
vi.mock("../reading/featureFlag", () => ({ useMobileFeatureFlag: () => true }));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryScreen } from "./LibraryScreen";
import { BookDetailsScreen } from "./BookDetailsScreen";
import { BookshelfScreen } from "./BookshelfScreen";
import { BookCoverCard } from "../components/BookCoverCard";
import type { MobileBook } from "../lib/books";

const mocks = vi.hoisted(() => ({
  eInk: false,
  navigate: vi.fn(),
  user: { id: "reader" } as { id: string } | null,
  loadBooks: vi.fn(async (): Promise<MobileBook[]> => []),
  loadShelf: vi.fn(async (_options?: import("../account/bookshelfCache").BookshelfLoadOptions): Promise<import("../account/accountData").MobileBookshelfEntry[]> => []),
  setShelf: vi.fn(async () => undefined),
  volumes: vi.fn(async () => [{ itemId: "test:full", itemKey: "full", title: "测试书", order: 0, manifestObject: "test.jox" }]),
  openTarget: vi.fn(),
}));

vi.mock("react-native", async () => {
  const { createElement, Fragment } = await import("react");
  return {
    ActivityIndicator: "progress", Pressable: "button", Text: "span", TextInput: "input", View: "div",
    Modal: "dialog",
    AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
    FlatList: ({ data, renderItem, keyExtractor }: {
      data: unknown[]; renderItem: (info: { item: unknown }) => ReactNode; keyExtractor: (item: unknown) => string;
    }) => createElement("section", null, data.map((item) =>
      createElement(Fragment, { key: keyExtractor(item) }, renderItem({ item })))),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1, absoluteFillObject: {} },
    Platform: { OS: "android", select: (values: { android: string }) => values.android },
    useWindowDimensions: () => ({ width: 390, height: 844 }),
  };
});
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "i" }));
vi.mock("@react-native-community/datetimepicker", () => ({ default: "time" }));
vi.mock("@react-navigation/native", async () => {
  const { useEffect } = await import("react");
  return { useNavigation: () => ({ navigate: mocks.navigate }), useFocusEffect: (callback: () => () => void) => useEffect(callback, [callback]) };
});
vi.mock("../account/auth", () => ({ useMobileAuthStore: (select: (state: { user: typeof mocks.user }) => unknown) => select({ user: mocks.user }) }));
vi.mock("../account/accountData", () => ({ loadMobileBookshelf: mocks.loadShelf, setMobileBookshelf: mocks.setShelf }));
// Download persistence is covered by offline/bookshelf and repository tests.
vi.mock("../offline/books", () => ({
  startMobileOfflineAccountSync: vi.fn(),
  mobileOfflineBooks: { download: vi.fn(), remove: vi.fn() },
  useMobileOfflineBooksStore: (select: (state: unknown) => unknown) => select({ books: [], loading: false, error: "" }),
}));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "main", useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../config/appVariant", () => ({ get IS_EINK_RELEASE() { return mocks.eInk; } }));
vi.mock("../components/BookCoverCard", () => ({ BookCoverCard: "book-card" }));
vi.mock("../components/PeriodicalCoverCard", () => ({ PeriodicalCoverCard: "article" }));
vi.mock("../components/ScreenHeader", () => ({ ScreenHeader: "header" }));
vi.mock("../lib/books", () => ({ loadMobileBooks: () => mocks.loadBooks(), loadMobileBookVolumes: mocks.volumes, resolveMobileBookOpenTarget: mocks.openTarget }));
vi.mock("../lib/haptics", () => ({ impactHaptic: vi.fn() }));
vi.mock("../store/mobileStore", () => ({
  useMobileStore: (select: (state: { hapticsEnabled: boolean; recentBooks: unknown[] }) => unknown) => select({ hapticsEnabled: false, recentBooks: [] }),
}));

let view: ReactTestRenderer | undefined;
describe("offline bookshelf screen", () => {
  it("shows cached entries and requests their covers by ID before the catalog is available", async () => {
    mocks.loadBooks.mockReturnValueOnce(new Promise(() => undefined));
    mocks.loadShelf.mockResolvedValue([{ datasetId: "book", itemId: "book:full", title: "本地书籍" }]);
    const props = { navigation: { navigate: mocks.navigate, goBack() {} } } as unknown as ComponentProps<typeof BookshelfScreen>;
    await act(async () => { view = create(<BookshelfScreen {...props} />); });
    const card = view!.root.findByType(BookCoverCard);
    expect(card.props).toMatchObject({ book: "book", itemKey: "book:full", title: "本地书籍" });
    await act(async () => card.props.onPress());
    expect(mocks.navigate).toHaveBeenCalledWith("BookReader", expect.objectContaining({ datasetId: "book", itemKey: "book:full" }));
  });

  it("keeps the shelf visible after a background synchronization error", async () => {
    let callbacks: import("../account/bookshelfCache").BookshelfLoadOptions | undefined;
    mocks.loadShelf.mockImplementationOnce(async (options) => { callbacks = options; return [{ datasetId: "book", itemId: "book:full", title: "本地书籍" }]; });
    const props = { navigation: { navigate: mocks.navigate, goBack() {} } } as unknown as ComponentProps<typeof BookshelfScreen>;
    await act(async () => { view = create(<BookshelfScreen {...props} />); });
    await act(async () => callbacks?.onError?.(new Error("offline")));
    expect(view!.root.findByType(BookCoverCard).props.title).toBe("本地书籍");
    await act(async () => callbacks?.onUpdate?.([]));
    expect(view!.root.findAllByType(BookCoverCard)).toHaveLength(0);
  });
});
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  mocks.loadBooks.mockResolvedValue([]);
  mocks.user = { id: "reader" };
  mocks.loadShelf.mockResolvedValue([]);
  mocks.setShelf.mockResolvedValue(undefined);
});
afterEach(async () => {
  if (view) await act(async () => view!.unmount());
  view = undefined;
});

describe.each([false, true])("library direct periodical entry (eInk=%s)", (eInk) => {
  beforeEach(() => { mocks.eInk = eInk; });

  it("opens newspapers and magazines directly without a date action or modal", async () => {
    await act(async () => { view = create(<LibraryScreen />); });
    const cards = view!.root.findAllByType("article");
    expect(cards).toHaveLength(ARCHIVE_PUBLICATIONS.length);
    for (const card of cards) {
      expect(card.props).not.toHaveProperty("onPickDate");
      await act(async () => card.props.onOpen());
      const publication = card.props.publication;
      expect(mocks.navigate).toHaveBeenLastCalledWith("Reader", {
        publication: publication.id,
        issueId: publication.id === "rmrb" ? getLatestRmrbAvailableDate() : publication.defaultIssueId,
      });
    }
    expect(mocks.navigate).toHaveBeenCalledTimes(ARCHIVE_PUBLICATIONS.length);
    expect(view!.root.findAllByType("dialog")).toHaveLength(0);
    expect(view!.root.findAllByType("time")).toHaveLength(0);
  });

  it("still opens a newspaper when the book catalog fails to load", async () => {
    mocks.loadBooks.mockRejectedValueOnce(new Error("offline"));
    await act(async () => { view = create(<LibraryScreen />); });
    expect(view!.root.findByProps({ accessibilityRole: "alert" }).props.children).toContain("报刊仍可正常使用");
    const card = view!.root.findAllByType("article").find((item) => item.props.publication.id === "ckxx")!;
    await act(async () => card.props.onOpen());
    expect(mocks.navigate).toHaveBeenCalledWith("Reader", { publication: "ckxx", issueId: card.props.publication.defaultIssueId });
    expect(view!.root.findAllByType("dialog")).toHaveLength(0);
  });

  const book: MobileBook = { datasetId: "test", title: "测试书", itemCount: 1, type: "book", indexObject: "test.jox" };
  async function press(label: string) {
    await act(async () => view!.root.findByProps({ accessibilityLabel: label }).props.onPress());
  }

  it("keeps the pressed book visibly busy until its directory is ready", async () => {
    let finish!: (value: { screen: "BookDetails"; book: MobileBook }) => void;
    mocks.openTarget.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    mocks.loadBooks.mockResolvedValue([book]);
    await act(async () => { view = create(<LibraryScreen />); });
    await act(async () => view!.root.findByType(BookCoverCard).props.onPress());
    expect(view!.root.findByType(BookCoverCard).props.busy).toBe(true);
    expect(mocks.navigate).not.toHaveBeenCalled();
    await act(async () => finish({ screen: "BookDetails", book }));
    expect(view!.root.findByType(BookCoverCard).props.busy).toBe(false);
    expect(mocks.navigate).toHaveBeenCalledWith("BookDetails", { book });
  });

  it("adds and removes a book from the library with one shelf read for the whole grid", async () => {
    mocks.loadBooks.mockResolvedValue([book]);
    await act(async () => { view = create(<LibraryScreen />); });
    expect(mocks.loadShelf).toHaveBeenCalledOnce();
    await press("加入书架");
    expect(mocks.setShelf).toHaveBeenCalledWith({ datasetId: "test", itemId: "test:full", title: "测试书", added: true });
    await press("移出书架");
    expect(mocks.setShelf).toHaveBeenLastCalledWith({ datasetId: "test", itemId: "test:full", title: "测试书", added: false });
  });

  it("keeps a guest's entry visible and routes to login without a shelf write", async () => {
    mocks.user = null;
    mocks.loadBooks.mockResolvedValue([book]);
    await act(async () => { view = create(<LibraryScreen />); });
    await press("加入书架");
    expect(mocks.navigate).toHaveBeenCalledWith("Account");
    expect(mocks.loadShelf).not.toHaveBeenCalled();
    expect(mocks.setShelf).not.toHaveBeenCalled();
  });

  it("lets a reader choose a series volume and add it from the volume page", async () => {
    const series = { ...book, itemCount: 2 };
    mocks.loadBooks.mockResolvedValue([series]);
    await act(async () => { view = create(<LibraryScreen />); });
    await press("选择分册");
    expect(mocks.navigate).toHaveBeenCalledWith("BookDetails", { book: series });
    expect(mocks.setShelf).not.toHaveBeenCalled();
    const props = { route: { params: { book: series } }, navigation: { navigate: mocks.navigate } } as unknown as ComponentProps<typeof BookDetailsScreen>;
    await act(async () => { view!.update(<BookDetailsScreen {...props} />); });
    await press("加入书架");
    expect(mocks.setShelf).toHaveBeenCalledWith({ datasetId: "test", itemId: "test:full", title: "测试书", added: true });
  });

  it("retries failed shelf lookup instead of permanently disabling the entry", async () => {
    mocks.loadBooks.mockResolvedValue([book]);
    mocks.loadShelf.mockRejectedValueOnce(new Error("offline"));
    await act(async () => { view = create(<LibraryScreen />); });
    await press("加入书架");
    expect(mocks.loadShelf).toHaveBeenCalledTimes(2);
    expect(mocks.setShelf).toHaveBeenCalledOnce();
    expect(view!.root.findAllByProps({ accessibilityRole: "alert" })).toHaveLength(0);
  });
});
