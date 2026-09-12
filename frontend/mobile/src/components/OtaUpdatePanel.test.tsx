import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OtaUpdatePanel } from "./OtaUpdatePanel";

const mocks = vi.hoisted(() => ({
  check: vi.fn(), fetch: vi.fn(), reload: vi.fn(), copy: vi.fn(),
  enabled: true,
  update: {} as Record<string, unknown>,
}));
vi.mock("react-native", () => ({
  ActivityIndicator: "progress", Pressable: "button", Text: "span", View: "div",
  Platform: { OS: "android", select: (values: { android: string }) => values.android },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock("expo-application", () => ({ applicationId: "com.luoxixi.jojokanbao" }));
vi.mock("expo-clipboard", () => ({ setStringAsync: mocks.copy }));
vi.mock("expo-updates", () => ({
  get isEnabled() { return mocks.enabled; },
  useUpdates: () => mocks.update,
  checkForUpdateAsync: mocks.check, fetchUpdateAsync: mocks.fetch, reloadAsync: mocks.reload,
}));

let view: ReactTestRenderer;
const text = () => view.root.findAllByType("span").map((node) => String(node.props.children)).join("\n");
const button = (label: string) => view.root.findAllByType("button").find((node) => node.findAllByType("span").some((child) => child.props.children === label))!;
const render = async () => { await act(async () => { view = create(<OtaUpdatePanel />); }); };
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, __DEV__: false });
  vi.resetAllMocks();
  mocks.enabled = true;
  mocks.update = {
    currentlyRunning: {
      isEmbeddedLaunch: false, isEmergencyLaunch: false,
      updateId: "running-old-update", createdAt: new Date("2026-09-12T09:44:57Z"),
      channel: "production-standard", runtimeVersion: "0.0.3",
    },
    isUpdatePending: false,
  };
  mocks.copy.mockResolvedValue(undefined);
});
afterEach(async () => { await act(async () => view?.unmount()); });

it("reports the running version separately from a downloaded update and never restarts on its own", async () => {
  mocks.update.isUpdatePending = true;
  mocks.update.downloadedUpdate = { updateId: "new-not-running-yet" };
  await render();
  expect(text()).toContain("版本标识：running-old-update");
  expect(text()).not.toContain("new-not-running-yet");
  expect(text()).toContain("热更新已下载，重启应用后生效。");
  expect(mocks.reload).not.toHaveBeenCalled();
  await act(async () => button("复制版本信息").props.onPress());
  expect(mocks.copy).toHaveBeenCalledWith(expect.stringContaining("版本标识：running-old-update"));
  expect(mocks.copy).toHaveBeenCalledWith(expect.stringContaining("有待应用更新：是"));
  await act(async () => button("重启并应用热更新").props.onPress());
  expect(mocks.reload).toHaveBeenCalledTimes(1);
  expect(mocks.check).not.toHaveBeenCalled();
});

it("downloads a manual update but waits for a separate apply action", async () => {
  mocks.check.mockResolvedValue({ isAvailable: true });
  mocks.fetch.mockResolvedValue({ isNew: true });
  await render();
  await act(async () => button("检查热更新").props.onPress());
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  expect(mocks.reload).not.toHaveBeenCalled();
  expect(text()).toContain("版本标识：running-old-update");
  expect(text()).toContain("热更新已下载，重启应用后生效。");
  await act(async () => button("重启并应用热更新").props.onPress());
  expect(mocks.reload).toHaveBeenCalledTimes(1);
});

it.each(["check", "fetch"] as const)("keeps a failed %s distinct from having no available update and permits retry", async (stage) => {
  mocks.check.mockResolvedValue({ isAvailable: true });
  mocks[stage].mockRejectedValueOnce(new Error("network timeout"));
  mocks.fetch.mockResolvedValueOnce({ isNew: true });
  await render();
  await act(async () => button("检查热更新").props.onPress());
  expect(text()).toContain(stage === "check" ? "热更新检查失败" : "热更新下载失败");
  expect(text()).not.toContain("本次未发现");
  expect(button("检查热更新").props.disabled).toBe(false);
});

it("does not call a previously failed update current or ask to apply it again", async () => {
  mocks.check.mockResolvedValue({ isAvailable: false, reason: "updatePreviouslyFailed" });
  await render();
  await act(async () => button("检查热更新").props.onPress());
  expect(text()).toContain("新热更新曾启动失败，当前仍在使用原版本");
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.reload).not.toHaveBeenCalled();
});

it("accepts a server rollback and retains the apply button after a restart failure", async () => {
  mocks.check.mockResolvedValue({ isAvailable: false, isRollBackToEmbedded: true });
  mocks.fetch.mockResolvedValue({ isNew: false, isRollBackToEmbedded: true });
  mocks.reload.mockRejectedValueOnce(new Error("restart failed"));
  await render();
  await act(async () => button("检查热更新").props.onPress());
  await act(async () => button("重启并应用热更新").props.onPress());
  expect(text()).toContain("重启失败");
  expect(button("重启并应用热更新").props.disabled).toBe(false);
  await act(async () => button("重启并应用热更新").props.onPress());
  expect(mocks.reload).toHaveBeenCalledTimes(2);
});

it("prevents overlapping checks and respects startup work already in progress", async () => {
  let resolveCheck!: (value: unknown) => void;
  mocks.check.mockImplementation(() => new Promise((resolve) => { resolveCheck = resolve; }));
  await render();
  const press = button("检查热更新").props.onPress;
  await act(async () => { press(); press(); });
  expect(mocks.check).toHaveBeenCalledTimes(1);
  expect(button("检查热更新").props.disabled).toBe(true);
  await act(async () => resolveCheck({ isAvailable: false, reason: "noUpdateAvailableOnServer" }));
  expect(text()).toContain("本次未发现可用热更新。");
  mocks.update.isStartupProcedureRunning = true;
  await act(async () => view.update(<OtaUpdatePanel />));
  expect(button("检查热更新").props.disabled).toBe(true);
  expect(text()).toContain("正在检查启动更新");
});

it("identifies an embedded fallback without calling disabled native update APIs", async () => {
  mocks.enabled = false;
  mocks.update.currentlyRunning = { isEmbeddedLaunch: true, isEmergencyLaunch: true };
  await render();
  expect(text()).toContain("安装包内置版本");
  expect(text()).toContain("当前已回退到可用版本");
  expect(button("检查热更新")).toBeUndefined();
  expect(mocks.check).not.toHaveBeenCalled();
});
