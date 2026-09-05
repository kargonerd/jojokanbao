export interface ReaderSelectionRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Place a reading action menu in viewport coordinates, clear of the selection handles. */
export function positionReaderSelection(
  selection: ReaderSelectionRect,
  viewport: ReaderSelectionRect,
  menu: { width: number; height: number },
) {
  if (selection.bottom <= viewport.top || selection.top >= viewport.bottom
    || selection.right <= viewport.left || selection.left >= viewport.right) return undefined;
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(min, max), Math.max(min, value));
  const width = Math.min(menu.width, Math.max(0, viewport.right - viewport.left - 24));
  const topEdge = viewport.top + 8;
  const bottomEdge = viewport.bottom - 8;
  const center = (Math.max(viewport.left, selection.left) + Math.min(viewport.right, selection.right)) / 2;
  const left = clamp(center - width / 2, viewport.left + 12, viewport.right - width - 12);
  const aboveTop = selection.top - 14 - menu.height;
  // Leave extra room below the range for native selection handles.
  const belowTop = selection.bottom + 28;
  const above = aboveTop >= topEdge || (belowTop + menu.height > bottomEdge
    && selection.top - topEdge > bottomEdge - selection.bottom);
  return {
    left,
    top: clamp(above ? aboveTop : belowTop, topEdge, bottomEdge - menu.height),
    width,
    above,
    arrowLeft: clamp(center - left, 20, width - 20),
  };
}
