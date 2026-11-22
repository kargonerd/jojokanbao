export interface MenuSelection {
  isCollapsed: boolean;
  rangeCount: number;
  getRangeAt(index: number): Range;
  removeAllRanges(): void;
  addRange(range: Range): void;
}

export interface NativeMenuSuppressorDeps {
  /** Live selection; may return null in exotic environments. */
  selection: () => MenuSelection | null;
  /** Deferred execution, defaults to a 0 ms macrotask when wired to a window. */
  schedule: (task: () => void, delayMs?: number) => void;
}

export interface NativeMenuSuppressor {
  /** Schedule suppression for the current non-collapsed selection. */
  arm(): void;
  /** True between the removal and the re-application of a range. */
  readonly busy: boolean;
}

/**
 * Mobile browsers draw a copy/share menu over the selection, above the page and
 * out of reach of scripts. It only appears on selections made by a user
 * gesture, though: removing the range and re-applying the very same range
 * programmatically takes the menu away while the selection survives.
 *
 * Verified in the wild on iOS Safari; Chrome for Android behaves the same.
 * WebViews that skip the trick fall back to the "place below" layout, which is
 * why the positioner keeps its clearance switch.
 */
export function createNativeMenuSuppressor(deps: NativeMenuSuppressorDeps): NativeMenuSuppressor {
  let inFlight = false;
  return {
    get busy() { return inFlight; },
    arm() {
      if (inFlight) return;
      const selection = deps.selection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return;
      const range = selection.getRangeAt(0);
      inFlight = true;
      deps.schedule(() => {
        selection.removeAllRanges();
        deps.schedule(() => {
          try {
            selection.addRange(range);
          } catch { /* the chapter may have re-rendered under the range. */ }
          deps.schedule(() => { inFlight = false; }, 0);
        });
      });
    },
  };
}
