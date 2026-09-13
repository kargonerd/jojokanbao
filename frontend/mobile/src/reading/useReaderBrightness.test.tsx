import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useReaderBrightness } from "./useReaderBrightness";

const native = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), error: vi.fn() }));
vi.mock("expo-brightness", () => ({ getBrightnessAsync: native.get, setBrightnessAsync: native.set }));
let view: ReactTestRenderer;
let brightness: ReturnType<typeof useReaderBrightness>;
function Reader() { brightness = useReaderBrightness(native.error); return null; }
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.resetAllMocks();
  native.get.mockResolvedValue(0.6); native.set.mockResolvedValue(undefined);
  await act(async () => { view = create(<Reader />); });
});
afterEach(async () => { await act(async () => view.unmount()); });

it("changes the screen while dragging, before the gesture is released", async () => {
  await act(async () => { brightness.changeBrightness(0.3); });
  expect(native.set).toHaveBeenCalledWith(0.3);
  expect(brightness.brightness).toBe(0.3);
});

it("serializes slow native writes and applies the most recent drag position next", async () => {
  let release!: () => void;
  native.set.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
  await act(async () => { brightness.changeBrightness(0.2); brightness.changeBrightness(0.4); brightness.changeBrightness(0.8); });
  expect(native.set.mock.calls).toEqual([[0.2]]);
  expect(brightness.brightness).toBe(0.8);
  await act(async () => release());
  expect(native.set.mock.calls).toEqual([[0.2], [0.8]]);
});

it("does not let a delayed initial brightness read undo the user's drag", async () => {
  await act(async () => view.unmount());
  let finish!: (value: number) => void;
  native.get.mockImplementationOnce(() => new Promise<number>((resolve) => { finish = resolve; }));
  await act(async () => { view = create(<Reader />); });
  await act(async () => brightness.changeBrightness(0.8));
  await act(async () => finish(0.2));
  expect(brightness.brightness).toBe(0.8);
});

it("can retry after a native failure without an unhandled rejection", async () => {
  native.set.mockRejectedValueOnce(new Error("unavailable"));
  await act(async () => brightness.changeBrightness(0.2));
  expect(native.error).toHaveBeenCalledTimes(1);
  await act(async () => brightness.changeBrightness(0.7));
  expect(native.set).toHaveBeenLastCalledWith(0.7);
});
