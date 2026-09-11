import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArchiveSearchResult } from "../lib/search";
import { SearchScreen } from "./SearchScreen";

const mocks = vi.hoisted(() => ({ search: vi.fn(), navigate: vi.fn(), eInk: false }));
vi.mock("react-native", () => ({
  ActivityIndicator: "progress", Pressable: "button", Text: "span", TextInput: "input", View: "div",
  FlatList: ({ data, renderItem, ListHeaderComponent, ListFooterComponent, ListEmptyComponent }: {
    data: ArchiveSearchResult[];
    renderItem: (value: { item: ArchiveSearchResult; index: number }) => ReactNode;
    ListHeaderComponent: ReactNode; ListFooterComponent: ReactNode; ListEmptyComponent: ReactNode;
  }) => <section>{ListHeaderComponent}{data.length ? data.map((item, index) => <article key={index}>{renderItem({ item, index })}</article>) : ListEmptyComponent}{ListFooterComponent}</section>,
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Platform: { OS: "android", select: (values: { android: string }) => values.android },
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: mocks.navigate }) }));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "main" }));
vi.mock("../components/ScreenHeader", () => ({ ScreenHeader: () => null }));
vi.mock("../config/appVariant", () => ({ get IS_EINK_RELEASE() { return mocks.eInk; } }));
vi.mock("../lib/haptics", () => ({ impactHaptic: vi.fn() }));
vi.mock("../lib/search", () => ({ searchArchive: mocks.search }));
vi.mock("../store/mobileStore", () => ({ useMobileStore: (select: (state: { hapticsEnabled: boolean }) => unknown) => select({ hapticsEnabled: false }) }));

const article = { title: "测试文章", content: "第一段正文。\n第二段正文。\n第三段正文。\n完整文章的结尾。", date: "1965-01-01", page: 2 };
let view: ReactTestRenderer;
function button(label: string, index = 0) {
  return view.root.findAllByType("button").filter((node) => node.findAllByType("span").some((child) => child.props.children === label))[index]!;
}
function content(text = article.content) {
  return view.root.findAllByType("span").find((node) => node.props.children === text)!;
}
async function search(keyword = "测试") {
  await act(async () => view.root.findByType("input").props.onChangeText(keyword));
  await act(async () => view.root.findByType("input").props.onSubmitEditing());
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  vi.clearAllMocks();
  mocks.search.mockResolvedValue({ results: [article, { ...article, title: "另一篇文章", content: "另一篇的正文" }], total: 20 });
  await act(async () => { view = create(<SearchScreen />); });
});
afterEach(async () => { await act(async () => view.unmount()); vi.unstubAllGlobals(); });

describe.each([false, true])("search article reading (eInk=%s)", (eInk) => {
  beforeEach(() => { mocks.eInk = eInk; });

  it("expands and collapses each article without opening the PDF", async () => {
    await search();
    expect(content().props.numberOfLines).toBe(3);
    await act(async () => button("显示全文").props.onPress());
    expect(content().props.numberOfLines).toBeUndefined();
    expect(content().props.selectable).toBe(true);
    expect(content("另一篇的正文").props.numberOfLines).toBe(3);
    expect(button("收起全文").props.accessibilityState).toEqual({ expanded: true });
    expect(mocks.navigate).not.toHaveBeenCalled();
    await act(async () => button("收起全文").props.onPress());
    expect(content().props.numberOfLines).toBe(3);
    await act(async () => button("查看原版 PDF").props.onPress());
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith("Reader", {
      publication: "rmrb", issueId: "19650101", page: 2, searchQuery: "测试", searchTitle: "测试文章",
    });
  });

  it("resets expanded articles on pagination and a new search", async () => {
    await search();
    await act(async () => button("显示全文").props.onPress());
    await act(async () => button("下一页 →").props.onPress());
    expect(mocks.search).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: "测试", page: 2 }));
    expect(content().props.numberOfLines).toBe(3);
    await act(async () => button("显示全文").props.onPress());
    await search("新关键词");
    expect(content().props.numberOfLines).toBe(3);
    expect(mocks.search).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: "新关键词", page: 1 }));
  });

  it("offers the PDF when article text is unavailable", async () => {
    mocks.search.mockResolvedValue({ results: [{ ...article, content: "", page: 0 }], total: 1 });
    await search();
    expect(content("暂无文字内容，可查看原版 PDF。")).toBeDefined();
    expect(button("显示全文")).toBeUndefined();
    await act(async () => button("查看原版 PDF").props.onPress());
    expect(mocks.navigate).toHaveBeenCalledWith("Reader", expect.objectContaining({ page: undefined }));
  });
});
