const minimumWindowSize = { width: 1024, height: 720 };
const preferredWindowSize = { width: 1280, height: 800 };
const restoreMargin = 96;

export function getDefaultWindowBounds(workArea) {
  const width = Math.min(
    preferredWindowSize.width,
    Math.max(minimumWindowSize.width, workArea.width - restoreMargin),
  );
  const height = Math.min(
    preferredWindowSize.height,
    Math.max(minimumWindowSize.height, workArea.height - restoreMargin),
  );

  return {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height,
  };
}

export function getRestorableWindowBounds(bounds, workArea, maximized) {
  const fillsWorkArea = bounds.width >= workArea.width * 0.96
    && bounds.height >= workArea.height * 0.96;

  return maximized && fillsWorkArea
    ? getDefaultWindowBounds(workArea)
    : bounds;
}
