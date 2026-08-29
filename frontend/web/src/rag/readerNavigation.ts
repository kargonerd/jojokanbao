export const READER_RETURN_STATE_KEY = "readerReturnTo";

export function safeReaderReturnPath(
  value: string | null | undefined,
  fallback = "/library?type=book",
): string {
  if (!value?.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\r\n]/.test(value)) {
    return fallback;
  }
  return value;
}

export function readerReturnState(path: string): { readerReturnTo: string } {
  return { [READER_RETURN_STATE_KEY]: safeReaderReturnPath(path) };
}

export function readerReturnPathFromState(state: unknown): string | undefined {
  if (!state || typeof state !== "object") return undefined;
  const value = (state as Record<string, unknown>)[READER_RETURN_STATE_KEY];
  return typeof value === "string" ? safeReaderReturnPath(value) : undefined;
}

export function withReaderReturnTo(path: string, returnTo: string): string {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}returnTo=${encodeURIComponent(safeReaderReturnPath(returnTo))}`;
}
