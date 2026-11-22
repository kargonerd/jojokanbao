export interface ReaderSelectionRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Place a reading action menu in viewport coordinates, clear of the selection handles. */
/**
 * `clearance` reserves the strip above the selection where a mobile browser draws
 * its own copy/share bar. When it is set the menu prefers the space below the
 * passage, which keeps it clear of that bar without leaving a gap nobody uses.
 */
export function positionReaderSelection(
  selection: ReaderSelectionRect,
  viewport: ReaderSelectionRect,
  menu: { width: number; height: number },
  clearance = 0,
) {
  if (selection.bottom <= viewport.top || selection.top >= viewport.bottom
    || selection.right <= viewport.left || selection.left >= viewport.right) return undefined;
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(min, max), Math.max(min, value));
  const width = Math.min(menu.width, Math.max(0, viewport.right - viewport.left - 24));
  const topEdge = viewport.top + 8;
  const bottomEdge = viewport.bottom - 8;
  const center = (Math.max(viewport.left, selection.left) + Math.min(viewport.right, selection.right)) / 2;
  const left = clamp(center - width / 2, viewport.left + 12, viewport.right - width - 12);
  const aboveTop = selection.top - 14 - menu.height - clearance;
  // Leave extra room below the range for native selection handles.
  const belowTop = selection.bottom + 28;
  const fitsBelow = belowTop + menu.height <= bottomEdge;
  const above = clearance > 0
    ? !fitsBelow && aboveTop >= topEdge
    : aboveTop >= topEdge || (belowTop + menu.height > bottomEdge
      && selection.top - topEdge > bottomEdge - selection.bottom);
  return {
    left,
    top: clamp(above ? aboveTop : belowTop, topEdge, bottomEdge - menu.height),
    width,
    above,
    arrowLeft: clamp(center - left, 20, width - 20),
  };
}
