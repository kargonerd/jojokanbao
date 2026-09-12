import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ userId: "reader" as string | null, submit: vi.fn(), list: vi.fn() }));
vi.mock("../account/auth", () => ({ useMobileAuthStore: (select: (state: unknown) => unknown) => select({ user: mocks.userId ? { id: mocks.userId } : null, initialized: true }) }));
vi.mock("./api", () => ({ mobileContentCorrections: { submit: mocks.submit, list: mocks.list } }));
vi.mock("react-native", () => ({
  KeyboardAvoidingView: "keyboard", Modal: "dialog", Pressable: "button", ScrollView: "scroll", Text: "text", TextInput: "input", View: "view",
  Platform: { OS: "android" }, StyleSheet: { create: (value: unknown) => value },
}));
vi.mock("../theme/tokens", () => ({ mobileTheme: { ink: "#202020", red: "#8b1a1a", paper: "#fff", inverse: "#fff", rule: "#ccc", muted: "#666", serif: "serif", eInk: false } }));
import { ContentCorrectionButton } from "./ContentCorrectionButton";
const source = { contentType: "book" as const, contentId: "test:book", contentTitle: "测试书", contentUrl: "/book/test/book?chapter=2", sectionId: "2", locationLabel: "第二章" };
const receipt = { ...source, id: "feedback-123", category: "typo", details: "文字有误", status: "pending", createdAt: "2026-09-08T00:00:00Z" };
let rendered: ReactTestRenderer;
async function open(onLogin = vi.fn()) {
  await act(async () => { rendered = create(<ContentCorrectionButton source={source} onLogin={onLogin} />); });
  await act(async () => { rendered.root.findByProps({ accessibilityLabel: "内容纠错" }).props.onPress(); });
}
beforeEach(() => { mocks.userId = "reader"; mocks.list.mockReset().mockResolvedValue([]); mocks.submit.mockReset().mockResolvedValue(receipt); });
afterEach(async () => { if (rendered) await act(async () => rendered.unmount()); });
describe("native content correction", () => {
  it("opens login through the reader callback and dismisses the native modal", async () => {
    mocks.userId = null;
    const login = vi.fn(); await open(login);
    const buttons = rendered.root.findAllByType("button");
    await act(async () => buttons.find((node) => node.findAllByType("text").some((text) => text.children.includes("登录后纠错")))!.props.onPress());
    expect(login).toHaveBeenCalledOnce();
    expect(rendered.root.findAllByType("dialog")).toHaveLength(0);
  });
  it("submits chapter context with the initiating account and confirms receipt", async () => {
    await open();
    await act(async () => rendered.root.findByProps({ accessibilityLabel: "问题说明" }).props.onChangeText("文字有误"));
    const button = rendered.root.findAllByType("button").find((node) => node.findAllByType("text").some((text) => text.children.includes("提交纠错")))!;
    await act(async () => button.props.onPress());
    expect(mocks.submit).toHaveBeenCalledWith({ ...source, quote: "" }, "typo", "文字有误", expect.any(String), "reader");
    expect(rendered.root.findAllByType("text").some((node) => node.children.includes("纠错已记录"))).toBe(true);
  });
  it("closes a stale form when the account changes during submission", async () => {
    let resolve: (value: unknown) => void = () => undefined;
    mocks.submit.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await open();
    await act(async () => rendered.root.findByProps({ accessibilityLabel: "问题说明" }).props.onChangeText("文字有误"));
    const button = rendered.root.findAllByType("button").find((node) => node.findAllByType("text").some((text) => text.children.includes("提交纠错")))!;
    await act(async () => button.props.onPress());
    mocks.userId = "another-reader";
    await act(async () => rendered.update(<ContentCorrectionButton source={source} onLogin={vi.fn()} />));
    await act(async () => { resolve(receipt); });
    expect(rendered.root.findAllByType("dialog")).toHaveLength(0);
  });
});
