import { ARCHIVE_PUBLICATIONS, getLatestRmrbAvailableDate } from "@jojo/content";
import { type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryScreen } from "./LibraryScreen";

const mocks = vi.hoisted(() => ({
  eInk: false,
  navigate: vi.fn(),
  loadBooks: vi.fn(async () => []),
}));

vi.mock("react-native", async () => {
  const { createElement, Fragment } = await import("react");
  return {
    ActivityIndicator: "progress", Pressable: "button", Text: "span", TextInput: "input", View: "div",
    Modal: "dialog",
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
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: mocks.navigate }) }));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "main", useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../config/appVariant", () => ({ get IS_EINK_RELEASE() { return mocks.eInk; } }));
vi.mock("../components/BookCoverCard", () => ({ BookCoverCard: "book-card" }));
vi.mock("../components/PeriodicalCoverCard", () => ({ PeriodicalCoverCard: "article" }));
vi.mock("../components/ScreenHeader", () => ({ ScreenHeader: "header" }));
vi.mock("../lib/books", () => ({ loadMobileBooks: () => mocks.loadBooks() }));
vi.mock("../lib/haptics", () => ({ impactHaptic: vi.fn() }));
vi.mock("../store/mobileStore", () => ({
  useMobileStore: (select: (state: { hapticsEnabled: boolean }) => unknown) => select({ hapticsEnabled: false }),
}));

let view: ReactTestRenderer | undefined;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  mocks.loadBooks.mockResolvedValue([]);
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
});
