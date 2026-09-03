import { describe, expect, it } from "vitest";
import { resolveAppVariant, resolveRuntimeAppVariant } from "./resolveAppVariant";

describe("mobile app variant", () => {
  it("selects the dedicated e-ink release only for the explicit build value", () => {
    expect(resolveAppVariant("eink")).toBe("eink");
    expect(resolveAppVariant(" EINK ")).toBe("eink");
    expect(resolveAppVariant("standard")).toBe("standard");
    expect(resolveAppVariant(undefined)).toBe("standard");
  });

  it("uses the Android package id as the native source of truth", () => {
    expect(resolveRuntimeAppVariant({ platform: "android", applicationId: "com.jojo.reader.eink", explicitVariant: "standard" })).toBe("eink");
    expect(resolveRuntimeAppVariant({ platform: "android", applicationId: "com.jojo.reader", explicitVariant: "eink" })).toBe("standard");
  });

  it("uses the explicit variant for browser-based visual previews", () => {
    expect(resolveRuntimeAppVariant({ platform: "web", applicationId: null, explicitVariant: "eink" })).toBe("eink");
  });
});
