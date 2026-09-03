import { describe, expect, it } from "vitest";
import { getLibraryCellWidth, getLibraryColumnCount } from "./tabletLayout";

describe("tablet grid layout", () => {
  it("matches the two-column mobile web shelf on phones", () => {
    expect(getLibraryColumnCount(390)).toBe(2);
    expect(getLibraryCellWidth(390, 2)).toBe(167);
  });

  it("uses three columns above the mobile breakpoint", () => {
    expect(getLibraryColumnCount(725)).toBe(3);
    expect(getLibraryCellWidth(725, 3)).toBe(217);
  });

  it("uses five columns on a landscape tablet", () => {
    expect(getLibraryColumnCount(1160)).toBe(5);
    expect(getLibraryCellWidth(1160, 5)).toBe(211);
  });
});
