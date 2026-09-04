import { describe, expect, it } from "vitest";
import { isNativeUpdateAvailable, parseNativeReleaseCatalog } from "./releaseCatalog";

const catalog = {
  schemaVersion: 1,
  product: "mobile",
  variant: "standard",
  channel: "stable",
  version: "1.2.3",
  buildNumber: 12,
  publishedAt: "2026-09-03T00:00:00Z",
  releaseNotesUrl: "https://example.com/notes",
  sourceUrl: "https://example.com/source",
  mandatory: false,
  minimumVersion: null,
  artifacts: [{
    id: "android-standard",
    platform: "android",
    arch: "universal",
    format: "apk",
    label: "Android 标准版",
    url: "https://blacknews.jojokanbao.cn/releases/mobile/android/stable/app.apk",
    size: 1024,
    sha256: "a".repeat(64),
  }],
};

describe("native release catalog", () => {
  it("validates the release and compares Android build numbers", () => {
    const parsed = parseNativeReleaseCatalog(catalog);
    expect(parsed).toBeDefined();
    expect(isNativeUpdateAvailable("11", parsed!)).toBe(true);
    expect(isNativeUpdateAvailable("12", parsed!)).toBe(false);
  });

  it("rejects beta catalogs", () => {
    expect(parseNativeReleaseCatalog({ ...catalog, channel: "beta" })).toBeUndefined();
  });

  it("rejects a catalog without an installable APK", () => {
    expect(parseNativeReleaseCatalog({ ...catalog, artifacts: [] })).toBeUndefined();
  });
});
