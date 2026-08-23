import { describe, expect, it } from "vitest";
import { getLibraryCellWidth, getLibraryColumnCount } from "./tabletLayout";

describe("tablet grid layout", () => {
  it("uses three columns on phones", () => {
    expect(getLibraryColumnCount(390)).toBe(3);
    expect(getLibraryCellWidth(390, 3)).toBe(109);
  });

  it("uses four columns on a portrait tablet", () => {
    expect(getLibraryColumnCount(725)).toBe(4);
    expect(getLibraryCellWidth(725, 4)).toBe(162);
  });

  it("uses five columns on a landscape tablet", () => {
    expect(getLibraryColumnCount(1160)).toBe(5);
    expect(getLibraryCellWidth(1160, 5)).toBe(214);
  });
});
