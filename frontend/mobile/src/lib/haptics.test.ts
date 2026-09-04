import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  impactAsync: vi.fn<() => Promise<void>>(),
  selectionAsync: vi.fn<() => Promise<void>>(),
}));

vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("expo-haptics", () => ({
  ImpactFeedbackStyle: { Heavy: "heavy", Medium: "medium" },
  impactAsync: mocks.impactAsync,
  selectionAsync: mocks.selectionAsync,
}));

import { impactHaptic, selectionHaptic, toggleHaptic } from "./haptics";

describe("mobile haptics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.impactAsync.mockResolvedValue(undefined);
    mocks.selectionAsync.mockResolvedValue(undefined);
  });

  it("does nothing when feedback is disabled", async () => {
    await selectionHaptic(false);
    await impactHaptic(false);
    await toggleHaptic(false, true);
    expect(mocks.impactAsync).not.toHaveBeenCalled();
  });

  it("uses perceptible Android strengths for interactions", async () => {
    await selectionHaptic(true);
    await impactHaptic(true);
    await toggleHaptic(true, true);
    await toggleHaptic(true, false);
    expect(mocks.impactAsync.mock.calls).toEqual([
      ["medium"],
      ["heavy"],
      ["heavy"],
      ["heavy"],
    ]);
  });

  it("keeps the app usable when the device rejects a vibration", async () => {
    mocks.impactAsync.mockRejectedValueOnce(new Error("unsupported"));
    await selectionHaptic(true);
    expect(mocks.impactAsync).toHaveBeenCalledOnce();
  });
});
