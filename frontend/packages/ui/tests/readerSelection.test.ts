import { describe, expect, it } from "vitest";
import { positionReaderSelection } from "../src/reader-selection";

const viewport = { left: 0, top: 48, right: 390, bottom: 760 };
const menu = { width: 320, height: 76 };

describe("reader selection menu placement", () => {
  it("stays close above a passage and points to the selection", () => {
    const position = positionReaderSelection({ left: 160, right: 210, top: 400, bottom: 428 }, viewport, menu)!;
    expect(position.above).toBe(true);
    expect(position.top + menu.height).toBe(386);
    expect(position.left + position.arrowLeft).toBe(185);
  });
  it("uses the space below a top-of-page selection, clearing its handles", () => {
    const position = positionReaderSelection({ left: 35, right: 90, top: 64, bottom: 90 }, viewport, menu)!;
    expect(position.above).toBe(false);
    expect(position.top).toBe(118);
    expect(position.left).toBe(12);
  });
  it("keeps menus inside a narrow or offset viewport", () => {
    const position = positionReaderSelection({ left: 295, right: 308, top: 400, bottom: 420 }, { ...viewport, left: 20, right: 310 }, menu)!;
    expect(position.width).toBe(266);
    expect(position.left).toBe(32);
    expect(position.arrowLeft).toBeLessThanOrEqual(position.width - 20);
  });
  it("clamps a multi-line selection menu inside the visible reading area", () => {
    const position = positionReaderSelection({ left: 40, right: 340, top: 70, bottom: 735 }, viewport, menu)!;
    expect(position.top).toBeGreaterThanOrEqual(viewport.top + 8);
    expect(position.top + menu.height).toBeLessThanOrEqual(viewport.bottom - 8);
  });
  it("hides actions when the selection scrolls outside the viewport", () => {
    expect(positionReaderSelection({ left: 100, right: 160, top: -60, bottom: 0 }, viewport, menu)).toBeUndefined();
  });
});
