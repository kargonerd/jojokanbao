import { describe, expect, it } from "vitest";
import { isLibraryBookVisible, libraryBookPolicy } from "../src/library-sources";

describe("library source visibility", () => {
  it("defaults legacy books to JOJO and keeps community opt-in even after login", () => {
    expect(isLibraryBookVisible({}, false)).toBe(true);
    expect(isLibraryBookVisible({ librarySource: "community" }, true)).toBe(false);
    expect(isLibraryBookVisible({ librarySource: "community" }, false, ["jojo", "community"])).toBe(false);
    expect(isLibraryBookVisible({ librarySource: "community" }, true, ["community"])).toBe(true);
  });
  it("applies the login and publication gates independently from source preferences", () => {
    expect(isLibraryBookVisible({ access: "authenticated" }, false)).toBe(false);
    expect(isLibraryBookVisible({ access: "authenticated" }, true)).toBe(true);
    expect(isLibraryBookVisible({ librarySource: "community", publicationStatus: "draft" }, true, ["community"])).toBe(false);
    expect(isLibraryBookVisible({}, true, [])).toBe(false);
  });
  it("does not let an old public child override a restricted parent", () => {
    const policy = libraryBookPolicy({ librarySource: "community", publicationStatus: "draft" }, { librarySource: "jojo", access: "public", publicationStatus: "published" });
    expect(policy).toEqual({ librarySource: "community", access: "authenticated", publicationStatus: "draft" });
    expect(isLibraryBookVisible(policy, true, ["community"])).toBe(false);
  });
  it("does not expose an unknown source as a legacy JOJO book", () => {
    expect(isLibraryBookVisible({ librarySource: "unknown" as "jojo" }, true, ["unknown"])).toBe(false);
  });
});
