export interface DesktopSearchResponse {
  ok: boolean;
  status?: number;
  data?: unknown;
  error?: string;
}

export type DesktopSearchTransport = (
  payload: Record<string, unknown>,
) => Promise<DesktopSearchResponse>;

/**
 * Optional capabilities injected by a non-Web host through its preload bridge.
 *
 * Packaged Electron builds load the renderer from file://, so the page origin
 * serializes as "null" and the public search service rejects the preflight.
 * The desktop shell therefore ships a main-process transport that bypasses the
 * renderer's fetch() entirely. Ordinary Web pages never see this bridge.
 */
export function getDesktopSearchTransport(): DesktopSearchTransport | undefined {
  if (typeof window === "undefined") return undefined;
  const bridge = (window as { jojoDesktop?: { search?: DesktopSearchTransport } }).jojoDesktop;
  return typeof bridge?.search === "function" ? bridge.search : undefined;
}
