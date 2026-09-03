import { describe, expect, it } from "vitest";
import { getAccountFormKeyboardLift, shouldRefreshDialogViewport } from "./dialogViewport";

describe("account dialog viewport", () => {
  it("ignores height-only keyboard resizes", () => {
    expect(shouldRefreshDialogViewport(460, 460)).toBe(false);
    expect(shouldRefreshDialogViewport(460, 468)).toBe(false);
  });

  it("refreshes the frozen viewport after a real orientation change", () => {
    expect(shouldRefreshDialogViewport(460, 736)).toBe(true);
    expect(shouldRefreshDialogViewport(736, 460)).toBe(true);
  });

  it("lifts only the form far enough to clear portrait and landscape keyboards", () => {
    expect(getAccountFormKeyboardLift(460)).toBe(-44);
    expect(getAccountFormKeyboardLift(1160)).toBe(-64);
  });
});
