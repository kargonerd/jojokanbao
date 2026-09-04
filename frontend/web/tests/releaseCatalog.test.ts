import { describe, expect, it } from "vitest";
import {
  detectedPlatform,
  formatReleaseSize,
  parseReleaseCatalog,
  recommendedArtifact,
  releaseCatalogUrls,
  type ReleaseCatalog,
} from "../src/download/releaseCatalog";

const desktop: ReleaseCatalog = {
  schemaVersion: 1,
  product: "desktop",
  channel: "stable",
  version: "1.2.3",
  publishedAt: "2026-09-03T00:00:00.000Z",
  releaseNotesUrl: "https://github.com/kargonerd/jojokanbao/releases/tag/desktop-v1.2.3",
  sourceUrl: "https://github.com/kargonerd/jojokanbao/tree/desktop-v1.2.3",
  artifacts: [{
    id: "windows-x64",
    platform: "windows",
    arch: "x64",
    format: "exe",
    label: "Windows x64",
    url: "https://blacknews.jojokanbao.cn/releases/desktop/stable/win-x64/JOJO.exe",
    size: 100 * 1024 * 1024,
    sha256: "a".repeat(64),
  }],
};

describe("Reader release catalogs", () => {
  it("builds three stable catalog endpoints under the existing content host", () => {
    expect(releaseCatalogUrls("https://blacknews.jojokanbao.cn/releases/")).toHaveLength(3);
    expect(releaseCatalogUrls("https://blacknews.jojokanbao.cn/releases/")[0]).toBe(
      "https://blacknews.jojokanbao.cn/releases/desktop/stable/catalog.json",
    );
  });

  it("validates catalogs and rejects unsafe artifact URLs", () => {
    expect(parseReleaseCatalog(desktop)).toEqual(desktop);
    expect(parseReleaseCatalog({ ...desktop, channel: "beta" })).toBeUndefined();
    expect(parseReleaseCatalog({ ...desktop, schemaVersion: 2 })).toBeUndefined();
    expect(parseReleaseCatalog({
      ...desktop,
      artifacts: [{ ...desktop.artifacts[0], url: "javascript:alert(1)" }],
    })).toBeUndefined();
  });

  it("recommends the matching device artifact", () => {
    expect(recommendedArtifact([desktop], "windows", "x64")?.id).toBe("windows-x64");
    expect(detectedPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toEqual({ platform: "windows", arch: "x64" });
    expect(formatReleaseSize(100 * 1024 * 1024)).toBe("100 MB");
  });
});
