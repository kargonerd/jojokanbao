import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MobileAiConversation } from "../store/mobileStore";
import { AiScreen } from "./AiScreen";

const mocks = vi.hoisted(() => ({
  books: vi.fn(), volumes: vi.fn(), ask: vi.fn(), navigate: vi.fn(),
  upsert: vi.fn(), remove: vi.fn(), conversations: [] as MobileAiConversation[],
}));
vi.mock("react-native", () => ({
  Pressable: "button", Text: "span", TextInput: "input", View: "div", KeyboardAvoidingView: "div",
  Modal: ({ visible, children }: { visible: boolean; children: ReactNode }) => visible ? children : null,
  FlatList: ({ data, renderItem, ListHeaderComponent, ListFooterComponent, ListEmptyComponent }: {
    data: unknown[]; renderItem: (value: { item: unknown; index: number }) => ReactNode;
    ListHeaderComponent?: ReactNode; ListFooterComponent?: ReactNode; ListEmptyComponent?: ReactNode;
  }) => <section>{ListHeaderComponent}{data.length ? data.map((item, index) => <article key={index}>{renderItem({ item, index })}</article>) : ListEmptyComponent}{ListFooterComponent}</section>,
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Platform: { OS: "android", select: (values: { android: string }) => values.android },
  Alert: { alert: vi.fn() },
}));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: () => null }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: mocks.navigate }) }));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "main" }));
vi.mock("../components/ScreenHeader", () => ({ ScreenHeader: () => null }));
vi.mock("../components/AuthenticatedFeatureGate", () => ({ AuthenticatedFeatureGate: () => null }));
vi.mock("../config/appVariant", () => ({ IS_EINK_RELEASE: false }));
vi.mock("../account/auth", () => ({ useMobileAuthStore: (select: (state: unknown) => unknown) => select({ initialized: true, user: { id: "user-1" } }) }));
vi.mock("../lib/books", () => ({ loadMobileBooks: mocks.books, loadMobileBookVolumes: mocks.volumes }));
vi.mock("../lib/libraryAgent", () => ({ askMobileLibraryAgent: mocks.ask }));
vi.mock("../store/mobileStore", () => ({ useMobileStore: (select: (state: unknown) => unknown) => select({
  aiConversations: mocks.conversations, upsertAiConversation: mocks.upsert, removeAiConversation: mocks.remove,
}) }));

let view: ReactTestRenderer;
function button(label: string) {
  return view.root.findAllByType("button").find((node) => node.props.accessibilityLabel === label
    || node.findAllByType("span").some((child) => child.props.children === label))!;
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  vi.clearAllMocks();
  mocks.conversations = [];
  mocks.books.mockResolvedValue([{ datasetId: "book-a", title: "甲书", aiEnabled: true }]);
  mocks.ask.mockReturnValue(vi.fn());
  mocks.upsert.mockImplementation((conversation: MobileAiConversation) => { mocks.conversations = [conversation]; });
  await act(async () => { view = create(<AiScreen />); });
});
afterEach(async () => { await act(async () => view.unmount()); vi.unstubAllGlobals(); });

it("selects People's Daily, persists the scope, and opens newspaper citations in the archive reader", async () => {
  await act(async () => button("选择资料，当前全部书籍").props.onPress());
  expect(button("甲书")).toBeDefined();
  await act(async () => button("报刊").props.onPress());
  expect(button("甲书")).toBeUndefined();
  expect(button("人民日报")).toBeDefined();
  expect(button("参考消息")).toBeUndefined();
  await act(async () => button("人民日报").props.onPress());
  await act(async () => button("关闭").props.onPress());
  await act(async () => view.root.findByType("input").props.onChangeText("黄河报道"));
  await act(async () => button("发送").props.onPress());
  expect(mocks.ask.mock.calls[0]?.[0]).toMatchObject({ contentType: "periodical", datasetIds: ["rmrb"], scopeMode: "selected" });
  expect(mocks.volumes).not.toHaveBeenCalled();
  const callbacks = mocks.ask.mock.calls[0]?.[1];
  await act(async () => {
    callbacks.onChunk("报道[cite:Jpaper]");
    callbacks.onDone("conv-paper", [{ citationId: "Jpaper", type: "newspaper", datasetId: "rmrb", itemId: "rmrb:1999-06-25", targetId: "article-1", date: "1999-06-25", page: 5, title: "关注黄河" }]);
  });
  expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ contentType: "periodical", selectedDatasetIds: ["rmrb"] }));
  const referenceButton = view.root.findAllByType("button").find((node) => node.findAllByType("span")
    .some((child) => Array.isArray(child.props.children) && child.props.children.includes("关注黄河")));
  await act(async () => referenceButton!.props.onPress());
  expect(mocks.navigate).toHaveBeenCalledWith("Reader", { publication: "rmrb", issueId: "19990625", page: 5, searchTitle: "关注黄河" });
  await act(async () => button("选择资料，当前仅《人民日报》").props.onPress());
  await act(async () => button("书籍").props.onPress());
  await act(async () => button("关闭").props.onPress());
  await act(async () => button("历史对话").props.onPress());
  await act(async () => button("黄河报道").props.onPress());
  expect(button("选择资料，当前仅《人民日报》")).toBeDefined();
});
