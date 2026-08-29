const DISPLAY_NAME_CACHE_KEY = "jojo-account-display-name";

interface CachedDisplayName {
  userId: string;
  displayName: string;
}

function localStorageOrUndefined(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function readCachedDisplayName(userId: string): string | null {
  try {
    const value = localStorageOrUndefined()?.getItem(DISPLAY_NAME_CACHE_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<CachedDisplayName>;
    const displayName = typeof parsed.displayName === "string" ? parsed.displayName.trim() : "";
    return parsed.userId === userId && displayName && displayName.length <= 50 ? displayName : null;
  } catch {
    return null;
  }
}

export function writeCachedDisplayName(userId: string, displayName: string): void {
  const normalized = displayName.trim();
  if (!userId || !normalized || normalized.length > 50) return;
  try {
    localStorageOrUndefined()?.setItem(DISPLAY_NAME_CACHE_KEY, JSON.stringify({
      userId,
      displayName: normalized,
    } satisfies CachedDisplayName));
  } catch {
    // Storage can be disabled without making account restoration fail.
  }
}

export function clearCachedDisplayName(): void {
  try {
    localStorageOrUndefined()?.removeItem(DISPLAY_NAME_CACHE_KEY);
  } catch {
    // Storage can be disabled without making sign-out fail.
  }
}
