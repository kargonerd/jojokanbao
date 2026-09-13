import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReaderNavigationSheet } from "./ReaderNavigationSheet";
import { editorialTheme } from "../theme/tokens";

const mocks = vi.hoisted(() => ({ height: 880, dismiss: vi.fn(), keyboard: vi.fn() }));
vi.mock("react-native", () => ({
  View: "div", Pressable: "button", Text: "span",
  Platform: { select: (options: { android: string }) => options.android },
  StyleSheet: { create: (styles: unknown) => styles },
  useWindowDimensions: () => ({ height: mocks.height }),
  Keyboard: { dismiss: mocks.keyboard },
  BackHandler: { addEventListener: () => ({ remove() {} }) },
  PanResponder: { create: (panHandlers: unknown) => ({ panHandlers }) },
}));
vi.mock("../config/appVariant", () => ({ IS_EINK_RELEASE: false }));
let view: ReactTestRenderer;
const props = { top: 96, bottom: 80, theme: editorialTheme, onClose: mocks.dismiss, compact: true };
const panelHeight = () => view.root.findAllByType("div").find((node) => Array.isArray(node.props.style) && node.props.style[1]?.height !== undefined)!.props.style[1].height;
const handle = () => view.root.findByProps({ accessibilityLabel: "调整阅读工具高度" });
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks(); mocks.height = 880;
  await act(async () => { view = create(<ReaderNavigationSheet {...props} contentHeight={280}><span>文字设置</span></ReaderNavigationSheet>); });
});
afterEach(async () => { await act(async () => view.unmount()); });

it("opens above the toolbar at its measured content height", () => { expect(panelHeight()).toBe(316); });
it("limits a tall settings sheet to the space below the header", async () => {
  mocks.height = 420;
  await act(async () => view.update(<ReaderNavigationSheet {...props} contentHeight={480}><span>文字设置</span></ReaderNavigationSheet>));
  expect(panelHeight()).toBe(244);
});
it("still expands upwards and closes on a downward drag", async () => {
  await act(async () => handle().props.onPanResponderRelease({}, { dy: -70 }));
  expect(panelHeight()).toBe(704);
  await act(async () => handle().props.onPanResponderRelease({}, { dy: 100 }));
  expect(mocks.dismiss).toHaveBeenCalledTimes(1);
  expect(mocks.keyboard).toHaveBeenCalledTimes(1);
});
