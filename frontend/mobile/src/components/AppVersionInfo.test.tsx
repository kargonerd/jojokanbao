import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppVersionInfo } from "./AppVersionInfo";

const mocks = vi.hoisted(() => ({ copy: vi.fn(), updateId: "running-version" as string | null }));
vi.mock("react-native", () => ({
  Pressable: "button", Text: "span", View: "div",
  Platform: { OS: "android", select: (values: { android: string }) => values.android },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock("expo-application", () => ({ applicationId: "com.luoxixi.jojokanbao", nativeApplicationVersion: "0.0.3", nativeBuildVersion: "5" }));
vi.mock("expo-clipboard", () => ({ setStringAsync: mocks.copy }));
vi.mock("expo-updates", () => ({ get updateId() { return mocks.updateId; } }));

let view: ReactTestRenderer;
const text = () => view.root.findAllByType("span").map((node) => String(node.props.children)).join("\n");
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.resetAllMocks();
  mocks.updateId = "running-version";
  mocks.copy.mockResolvedValue(undefined);
  await act(async () => { view = create(<AppVersionInfo />); });
});
afterEach(async () => { await act(async () => view.unmount()); });

it("shows one running version and copies only that information", async () => {
  expect(text()).toBe("版本标识：running-version\n复制版本信息");
  expect(view.root.findAllByType("button")).toHaveLength(1);
  await act(async () => view.root.findByType("button").props.onPress());
  expect(mocks.copy).toHaveBeenCalledExactlyOnceWith("版本标识：running-version");
  expect(text()).toContain("版本信息已复制。");
});

it("falls back to the installed version when a running update ID is unavailable", async () => {
  mocks.updateId = null;
  await act(async () => view.update(<AppVersionInfo />));
  expect(text()).toContain("版本标识：0.0.3.5");
});

it("retains a selectable version if copying fails", async () => {
  mocks.copy.mockRejectedValueOnce(new Error("clipboard unavailable"));
  await act(async () => view.root.findByType("button").props.onPress());
  expect(text()).toContain("复制失败，可长按上方版本标识复制。");
  expect(view.root.findAllByType("span").find((node) => node.props.selectable)?.props.children).toBe("版本标识：running-version");
});
