const GRID_HORIZONTAL_PADDING = 20;
const GRID_GAP = 16;

export function getLibraryColumnCount(viewportWidth: number): number {
  if (viewportWidth >= 1000) return 5;
  if (viewportWidth > 720) return 3;
  return 2;
}

export function getLibraryCellWidth(viewportWidth: number, columnCount: number): number {
  const availableWidth = viewportWidth
    - GRID_HORIZONTAL_PADDING * 2
    - GRID_GAP * (columnCount - 1);
  return Math.floor(Math.max(0, availableWidth) / columnCount);
}
