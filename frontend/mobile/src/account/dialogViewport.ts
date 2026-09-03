const DIALOG_WIDTH_CHANGE_THRESHOLD = 32;

export function shouldRefreshDialogViewport(currentWidth: number, nextWidth: number): boolean {
  return Math.abs(nextWidth - currentWidth) > DIALOG_WIDTH_CHANGE_THRESHOLD;
}
