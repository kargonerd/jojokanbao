import type { ComponentProps } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OfflineBookRecord } from "@jojo/content";
import { BookshelfScreen } from "../screens/BookshelfScreen";

const mocks = vi.hoisted(() => ({
  entries: [] as { datasetId: string; itemId: string; title: string }[], records: [] as OfflineBookRecord[],
  loading: false, toggle: vi.fn(), navigate: vi.fn(), download: vi.fn(), remove: vi.fn(),
}));
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  return { View: "div", Text: "span", Pressable: "button", ActivityIndicator: "progress", Platform: { OS: "android", select: (values: { android: string }) => values.android },
    StyleSheet: { create: (styles: unknown) => styles }, useWindowDimensions: () => ({ width: 390 }),
    FlatList: ({ data, renderItem, ListHeaderComponent, ListEmptyComponent }: { data: unknown[]; renderItem: (info: { item: unknown }) => import("react").ReactNode; ListHeaderComponent: import("react").ReactNode; ListEmptyComponent: import("react").ReactNode }) => createElement("section", {}, ListHeaderComponent, data.length ? data.map((item, index) => createElement("article", { key: index }, renderItem({ item }))) : ListEmptyComponent),
  };
});
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "i" }));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "main" }));
vi.mock("../components/ScreenHeader", () => ({ ScreenHeader: () => null }));
vi.mock("../components/BookCoverCard", () => ({ BookCoverCard: "cover" }));
vi.mock("../account/useBookshelf", () => ({ useBookshelf: () => ({ entries: mocks.entries, loading: mocks.loading, error: "", busyKey: "", toggle: mocks.toggle, reload: vi.fn() }) }));
vi.mock("../lib/books", () => ({ loadMobileBooks: async () => [] }));
vi.mock("../lib/useRetryOnFailure", () => ({ useRetryOnFailure: () => undefined }));
vi.mock("../lib/nativePerformance", () => ({ REMOVE_CLIPPED_SUBVIEWS: false }));
vi.mock("../config/appVariant", () => ({ IS_EINK_RELEASE: false }));
vi.mock("../store/mobileStore", () => ({ useMobileStore: (select: (state: unknown) => unknown) => select({ recentBooks: [] }) }));
vi.mock("./books", () => ({
  startMobileOfflineAccountSync: vi.fn(),
  mobileOfflineBooks: { download: mocks.download, remove: mocks.remove },
  useMobileOfflineBooksStore: (select: (state: unknown) => unknown) => select({ books: mocks.records, loading: false, error: "" }),
}));
const entry = { datasetId: "books", itemId: "book:one", title: "一本书" };
function record(status: OfflineBookRecord["status"] = "ready") {
  return { id: "one", entry: { datasetId: "books" }, item: { itemId: "book:one", itemKey: "one", title: "一本书" }, status, bytes: 2048, total: 10, completed: 4 } as OfflineBookRecord;
}
let view: ReactTestRenderer;
async function renderShelf() {
  const props = { navigation: { navigate: mocks.navigate, goBack: vi.fn() }, route: { key: "shelf", name: "Bookshelf" } } as unknown as ComponentProps<typeof BookshelfScreen>;
  await act(async () => { view = create(<BookshelfScreen {...props} />); });
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks(); mocks.entries = []; mocks.records = []; mocks.loading = false;
  mocks.download.mockResolvedValue(undefined); mocks.remove.mockResolvedValue(undefined);
});
afterEach(async () => { await act(async () => view?.unmount()); });
it("opens a local book from the shelf while cloud loading is still pending", async () => {
  mocks.records = [record()]; mocks.loading = true; await renderShelf();
  await act(async () => view.root.findByType("cover" as never).props.onPress());
  expect(mocks.navigate).toHaveBeenCalledWith("BookReader", expect.objectContaining({ datasetId: "books", itemKey: "one" }));
  expect(view.root.findAllByProps({ accessibilityLabel: "移出书架：一本书" })).toHaveLength(0);
});
it("deduplicates cloud IDs and local keys, and deletes the download without changing the cloud shelf", async () => {
  mocks.entries = [entry]; mocks.records = [record()]; await renderShelf();
  expect(view.root.findAllByType("cover" as never)).toHaveLength(1);
  await act(async () => view.root.findByProps({ accessibilityLabel: "可离线：一本书" }).props.onPress());
  await act(async () => view.root.findByProps({ accessibilityLabel: "删除下载：一本书" }).props.onPress());
  expect(mocks.remove).toHaveBeenCalledWith(mocks.records[0]);
  expect(mocks.toggle).not.toHaveBeenCalled();
});
it("downloads from the book card", async () => {
  mocks.entries = [entry]; await renderShelf();
  await act(async () => view.root.findByProps({ accessibilityLabel: "下载：一本书" }).props.onPress());
  expect(mocks.download).toHaveBeenCalledWith({ datasetId: "books", itemKey: "book:one", title: "一本书" });
});
it("shows progress and cancels the selected book", async () => {
  mocks.records = [record("downloading")]; await renderShelf();
  expect(view.root.findByProps({ accessibilityRole: "progressbar" }).props.accessibilityValue.now).toBe(40);
  await act(async () => view.root.findByProps({ accessibilityLabel: "取消下载：一本书" }).props.onPress());
  expect(mocks.remove).toHaveBeenCalledWith(mocks.records[0]);
});
