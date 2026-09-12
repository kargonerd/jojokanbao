let desktopBooksEnabled = false;

/** Called by the desktop entry only; ordinary Web pages never enable downloads. */
export function enableDesktopOfflineBooks(): void { desktopBooksEnabled = true; }
export function supportsOfflineBooks(): boolean { return desktopBooksEnabled; }
