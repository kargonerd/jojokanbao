import { describe, expect, it } from "vitest";
import { resolveAppVariant } from "./resolveAppVariant";

describe("mobile app variant", () => {
  it("selects the dedicated e-ink release only for the explicit build value", () => {
    expect(resolveAppVariant("eink")).toBe("eink");
    expect(resolveAppVariant(" EINK ")).toBe("eink");
    expect(resolveAppVariant("standard")).toBe("standard");
    expect(resolveAppVariant(undefined)).toBe("standard");
  });
});
