const DIALOG_WIDTH_CHANGE_THRESHOLD = 32;
const WIDE_DIALOG_THRESHOLD = 880;

export function shouldRefreshDialogViewport(currentWidth: number, nextWidth: number): boolean {
  return Math.abs(nextWidth - currentWidth) > DIALOG_WIDTH_CHANGE_THRESHOLD;
}

export function getAccountFormKeyboardLift(dialogWidth: number): number {
  return dialogWidth > WIDE_DIALOG_THRESHOLD ? -64 : -44;
}
