import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

import { REMOVE_CLIPPED_SUBVIEWS, shouldRemoveClippedSubviews } from "./nativePerformance";

describe("native list performance", () => {
  it("keeps Android clipping without enabling the unsafe iOS path", () => {
    expect(shouldRemoveClippedSubviews("android")).toBe(true);
    expect(shouldRemoveClippedSubviews("ios")).toBe(false);
    expect(REMOVE_CLIPPED_SUBVIEWS).toBe(false);
  });
});
