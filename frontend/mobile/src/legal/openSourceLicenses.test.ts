import { describe, expect, it } from "vitest";
import licenseData from "./open-source-notices.generated.json";

describe("mobile open-source notices", () => {
  it("ships the project license and locked runtime dependencies", () => {
    expect(licenseData.projectLicense).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
    expect(licenseData.lockfileSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(licenseData.packages.length).toBeGreaterThan(100);
    expect(licenseData.packages.some((item) => item.name === "react-native")).toBe(true);
    expect(Object.keys(licenseData.notices).length).toBeGreaterThan(0);
  });
});
