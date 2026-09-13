import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReaderNavigationSheet } from "./ReaderNavigationSheet";
import { editorialTheme, eInkTheme } from "../theme/tokens";

const mocks = vi.hoisted(() => ({
  height: 880, dismiss: vi.fn(), keyboard: vi.fn(), reduceMotion: false,
  animations: vi.fn(), contentRenders: vi.fn(),
}));
vi.mock("react-native", () => {
  class Value {
    value: number;
    constructor(value: number) { this.value = value; }
    setValue(value: number) { this.value = value; }
    stopAnimation(callback?: (value: number) => void) { callback?.(this.value); }
    interpolate(config: unknown) { return { source: this, config }; }
  }
  const animation = (kind: string) => (value: Value, config: { toValue: number }) => {
    mocks.animations(kind, config);
    return { start(callback?: (result: { finished: boolean }) => void) { value.setValue(config.toValue); callback?.({ finished: true }); } };
  };
  return {
    View: "div", Pressable: "button", Text: "span",
    Animated: { Value, View: "div", spring: animation("spring"), timing: animation("timing") },
    AccessibilityInfo: { isReduceMotionEnabled: async () => mocks.reduceMotion, addEventListener: () => ({ remove() {} }) },
    Platform: { select: (options: { android: string }) => options.android },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    useWindowDimensions: () => ({ height: mocks.height }),
    Keyboard: { dismiss: mocks.keyboard },
    BackHandler: { addEventListener: () => ({ remove() {} }) },
    PanResponder: { create: (panHandlers: unknown) => ({ panHandlers }) },
  };
});
vi.mock("../config/appVariant", () => ({ IS_EINK_RELEASE: false }));
let view: ReactTestRenderer;
const props = { top: 96, bottom: 80, theme: editorialTheme, onClose: mocks.dismiss, compact: true };
function Content() { mocks.contentRenders(); return <span>文字设置</span>; }
const surface = () => view.root.findByProps({ testID: "reader-sheet-surface" });
const content = () => view.root.findByProps({ testID: "reader-sheet-content" });
const panelHeight = () => content().props.style[1].height;
const offset = () => surface().props.style[1].transform[0].translateY.value;
const handle = () => view.root.findByProps({ accessibilityLabel: "调整阅读工具高度" });
const gesture = (dy: number, vy = 0, dx = 0, numberActiveTouches = 1) => ({ dy, vy, dx, numberActiveTouches });
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks(); mocks.height = 880; mocks.reduceMotion = false;
  await act(async () => { view = create(<ReaderNavigationSheet {...props} contentHeight={280}><Content /></ReaderNavigationSheet>); });
});
afterEach(async () => { await act(async () => view.unmount()); vi.restoreAllMocks(); });

it("opens above the toolbar at its measured height while keeping the surface layout fixed", () => {
  expect(panelHeight()).toBe(316);
  expect(surface().props.style[1].height).toBe(704);
  expect(offset()).toBe(388);
});
it("limits tall settings to the space below the header and updates the resting position after rotation", async () => {
  mocks.height = 420;
  await act(async () => view.update(<ReaderNavigationSheet {...props} contentHeight={480}><Content /></ReaderNavigationSheet>));
  expect(panelHeight()).toBe(244);
  expect(surface().props.style[1].height).toBe(244);
  expect(offset()).toBe(0);
});
it("follows every move without changing content height or rendering scroll content again", async () => {
  const renders = mocks.contentRenders.mock.calls.length;
  await act(async () => handle().props.onPanResponderGrant());
  await act(async () => handle().props.onPanResponderMove({}, gesture(35)));
  expect(offset()).toBe(423);
  await act(async () => handle().props.onPanResponderMove({}, gesture(61)));
  expect(offset()).toBe(449);
  expect(panelHeight()).toBe(316);
  expect(surface().props.style[1].height).toBe(704);
  expect(mocks.contentRenders).toHaveBeenCalledTimes(renders);
  expect(mocks.animations).not.toHaveBeenCalled();
});
it("follows an upward compact drag before expanding and closes on a long downward drag", async () => {
  await act(async () => handle().props.onPanResponderGrant());
  await act(async () => handle().props.onPanResponderMove({}, gesture(-70)));
  expect(offset()).toBe(318);
  expect(panelHeight()).toBe(316);
  await act(async () => handle().props.onPanResponderRelease({}, gesture(-70)));
  expect(panelHeight()).toBe(704);
  expect(offset()).toBe(0);
  expect(mocks.animations).toHaveBeenCalledWith("spring", expect.objectContaining({ useNativeDriver: true, toValue: 0 }));
  await act(async () => handle().props.onPanResponderRelease({}, gesture(150)));
  expect(mocks.dismiss).toHaveBeenCalledTimes(1);
  expect(mocks.keyboard).toHaveBeenCalledTimes(1);
});
it("uses downward velocity to dismiss a short flick", async () => {
  await act(async () => handle().props.onPanResponderRelease({}, gesture(20, .8)));
  expect(mocks.dismiss).toHaveBeenCalledTimes(1);
  expect(mocks.animations).toHaveBeenCalledWith("timing", expect.objectContaining({ useNativeDriver: true }));
});
it("springs a short slow drag back and does not treat it as a handle tap", async () => {
  await act(async () => handle().props.onPanResponderGrant());
  await act(async () => handle().props.onPanResponderMove({}, gesture(30)));
  await act(async () => handle().props.onPanResponderRelease({}, gesture(30)));
  expect(offset()).toBe(388);
  expect(panelHeight()).toBe(316);
  expect(mocks.dismiss).not.toHaveBeenCalled();
});
it("does not dismiss using stale flick velocity after the reader holds the handle", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(1000);
  await act(async () => handle().props.onPanResponderGrant());
  await act(async () => handle().props.onPanResponderMove({}, gesture(25, 1)));
  now.mockReturnValue(1200);
  await act(async () => handle().props.onPanResponderRelease({}, gesture(25, 1)));
  expect(offset()).toBe(388);
  expect(mocks.dismiss).not.toHaveBeenCalled();
});
it("returns to the resting point after responder cancellation", async () => {
  await act(async () => handle().props.onPanResponderGrant());
  await act(async () => handle().props.onPanResponderMove({}, gesture(95)));
  await act(async () => handle().props.onPanResponderTerminate());
  expect(offset()).toBe(388);
  expect(mocks.dismiss).not.toHaveBeenCalled();
});
it("keeps gesture handlers on the handle instead of intercepting scrolling children", () => {
  expect(content().props.onMoveShouldSetPanResponder).toBeUndefined();
  expect(surface().props.onMoveShouldSetPanResponder).toBeUndefined();
  expect(handle().props.onMoveShouldSetPanResponder({}, gesture(30, 0, 2))).toBe(true);
  expect(handle().props.onMoveShouldSetPanResponder({}, gesture(3, 0, 30))).toBe(false);
  expect(handle().props.onMoveShouldSetPanResponder({}, gesture(30, 0, 0, 2))).toBe(false);
});
it("retains the active pan responder when reader state rerenders the sheet", async () => {
  const move = handle().props.onPanResponderMove;
  await act(async () => view.update(<ReaderNavigationSheet {...props} onClose={() => mocks.dismiss()} contentHeight={280}><Content /></ReaderNavigationSheet>));
  expect(handle().props.onPanResponderMove).toBe(move);
});
it("provides a dimmed backdrop and an unclipped shadow with a theme-colored flat edge", () => {
  expect(view.root.findByProps({ accessibilityLabel: "关闭阅读工具" }).props.style.backgroundColor).toBe("#000000");
  expect(surface().props.style[0].overflow).toBeUndefined();
  expect(surface().props.style[0].borderRadius).toBeUndefined();
  expect(surface().props.style[1]).toMatchObject({ backgroundColor: editorialTheme.paper, borderTopColor: editorialTheme.rule, elevation: 12 });
});
it("keeps direct manipulation but disables release animation and shadows for e-ink", async () => {
  await act(async () => view.update(<ReaderNavigationSheet {...props} theme={eInkTheme} contentHeight={280}><Content /></ReaderNavigationSheet>));
  await act(async () => handle().props.onPanResponderGrant());
  await act(async () => handle().props.onPanResponderMove({}, gesture(25)));
  expect(offset()).toBe(413);
  await act(async () => handle().props.onPanResponderRelease({}, gesture(25)));
  expect(offset()).toBe(388);
  expect(mocks.animations).not.toHaveBeenCalled();
  expect(surface().props.style[1]).toMatchObject({ shadowOpacity: 0, elevation: 0 });
});
it("respects the system's reduced-motion setting", async () => {
  await act(async () => view.unmount());
  mocks.reduceMotion = true;
  await act(async () => { view = create(<ReaderNavigationSheet {...props} contentHeight={280}><Content /></ReaderNavigationSheet>); });
  await act(async () => handle().props.onPanResponderRelease({}, gesture(20, .8)));
  expect(mocks.dismiss).toHaveBeenCalledTimes(1);
  expect(mocks.animations).not.toHaveBeenCalled();
});
it("lets accessibility actions expand and dismiss the panel", async () => {
  await act(async () => handle().props.onAccessibilityAction({ nativeEvent: { actionName: "increment" } }));
  expect(panelHeight()).toBe(704);
  expect(offset()).toBe(0);
  await act(async () => handle().props.onAccessibilityAction({ nativeEvent: { actionName: "decrement" } }));
  expect(mocks.dismiss).toHaveBeenCalledTimes(1);
});
