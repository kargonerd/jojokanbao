import { beforeEach, describe, expect, it } from "vitest";
import {
  clearCachedDisplayName,
  readCachedDisplayName,
  writeCachedDisplayName,
} from "../src/account/profileCache";

describe("account display-name cache", () => {
  beforeEach(() => window.localStorage.clear());

  it("reuses a normalized display name only for the matching account", () => {
    writeCachedDisplayName("reader-1", "  长鯙-WUP  ");

    expect(readCachedDisplayName("reader-1")).toBe("长鯙-WUP");
    expect(readCachedDisplayName("reader-2")).toBeNull();
  });

  it("clears the cached identity on sign-out", () => {
    writeCachedDisplayName("reader-1", "长鯙-WUP");
    clearCachedDisplayName();
    expect(readCachedDisplayName("reader-1")).toBeNull();
  });
});
