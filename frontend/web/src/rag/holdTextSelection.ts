/**
 * Chromium does not start a long-press text selection for a touch that began
 * while the scroll surface was still gliding — and in paged mode even a real
 * finger's few pixels of drift are enough to kill the native gesture. Readers
 * swipe or turn a page and then want to mark a passage, so they hit this
 * constantly; tapping "fixes" it only because the tap consumes the glide.
 *
 * The fallback watches for a still finger (drift within the drag threshold)
 * whose surface kept moving during the hold, or whose finger drifted at all in
 * paged mode: it stops the glide, picks the word under the finger and applies
 * it as a programmatic selection. Our selectionchange capture then shows the
 * toolbar as usual. A stationary finger on a stationary surface keeps the
 * native gesture untouched, so the native handles survive wherever they worked
 * before.
 */

const HOLD_MS = 450;
const GLIDE_EPSILON = 2;
const DRIFT_TRIGGERS_PX = 2;
const MOVE_CANCELS_PX = 10;
const INTERACTIVE_SELECTOR = "a,button,input,textarea,select,label,[role='button'],[contenteditable='true'],img";

export interface HoldTextSelectionDeps {
  /** The scrollable reading surface; glides must be observable here. */
  surface: () => HTMLElement | null;
  selection: () => Selection | null;
  /** Deferred execution; returns a canceller. */
  schedule: (task: () => void, delayMs: number) => () => void;
  /** Hit-test a viewport point; null means "nothing selectable there". */
  hitTest?: (x: number, y: number) => Range | null;
  /** Skip the fallback when overlays own the screen. */
  blocked?: () => boolean;
  /**
   * Stop the surface's glide before the selection is applied. Defaults to
   * hiding the overflow, which interrupts a scrolling surface.
   */
  freeze?: (surface: HTMLElement) => void;
  /**
   * Paged surfaces move the text under a drifting finger even without a
   * glide; when true, any finger drift triggers the fallback.
   */
  driftTriggers?: boolean;
}

export interface HoldTextSelectionHandlers {
  onTouchStart: (event: TouchEvent) => void;
  onTouchMove: (event: TouchEvent) => void;
  onTouchEnd: () => void;
  onTouchCancel: () => void;
  dispose: () => void;
}

export function createHoldTextSelection(deps: HoldTextSelectionDeps): HoldTextSelectionHandlers {
  let cancelHold: (() => void) | undefined;
  let startX = 0;
  let startY = 0;
  let startOffset = 0;
  let maxDrift = 0;
  let tracking = false;

  function cancel(): void {
    cancelHold?.();
    cancelHold = undefined;
    tracking = false;
  }

  function onTouchStart(event: TouchEvent): void {
    cancel();
    if (event.touches.length !== 1) return;
    if ((event.target as Element | null)?.closest?.(INTERACTIVE_SELECTOR)) return;
    const surface = deps.surface();
    if (!surface) return;
    startX = event.touches[0]!.clientX;
    startY = event.touches[0]!.clientY;
    startOffset = surface.scrollLeft + surface.scrollTop;
    maxDrift = 0;
    tracking = true;
    cancelHold = deps.schedule(() => {
      cancelHold = undefined;
      holdFired(startX, startY, startOffset);
    }, HOLD_MS);
  }

  function onTouchMove(event: TouchEvent): void {
    if (!tracking) return;
    const touch = event.touches[0];
    if (!touch) { cancel(); return; }
    const drift = Math.hypot(touch.clientX - startX, touch.clientY - startY);
    maxDrift = Math.max(maxDrift, drift);
    if (drift > MOVE_CANCELS_PX) cancel();
  }

  function holdFired(x: number, y: number, offsetAtStart: number): void {
    const surface = deps.surface();
    const selection = deps.selection();
    if (!surface || !selection || !selection.isCollapsed || deps.blocked?.()) { cancel(); return; }
    // A surface that stayed put and a finger that did not drift mean the
    // native long-press owns this press.
    const surfaceMoved = Math.abs(surface.scrollLeft + surface.scrollTop - offsetAtStart) > GLIDE_EPSILON;
    const fingerDrifted = maxDrift > DRIFT_TRIGGERS_PX;
    if (!surfaceMoved && !(deps.driftTriggers && fingerDrifted)) { cancel(); return; }
    const range = pickWordRange(surface, x, y, deps.hitTest);
    if (!range) { cancel(); return; }
    // Interrupting the scroller stops the glide so the highlight, the toolbar
    // and any further layout agree on the same coordinates.
    if (deps.freeze) deps.freeze(surface);
    else {
      const previousOverflow = surface.style.overflow;
      surface.style.overflow = "hidden";
      deps.schedule(() => { surface.style.overflow = previousOverflow; }, 60);
    }
    selection.removeAllRanges();
    selection.addRange(range);
    cancel();
  }

  return {
    onTouchStart,
    onTouchMove,
    onTouchEnd: cancel,
    onTouchCancel: cancel,
    dispose: cancel,
  };
}

/** Select the word (letter run) under a viewport point, native-style. */
export function pickWordRange(
  surface: HTMLElement,
  x: number,
  y: number,
  hitTest?: (x: number, y: number) => Range | null,
): Range | null {
  const document = surface.ownerDocument;
  const collapsed = hitTest ? hitTest(x, y) : document.caretRangeFromPoint
    ? document.caretRangeFromPoint(x, y)
    : null;
  if (!collapsed) return null;
  const node = collapsed.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return null;
  const textNode = node as Text;
  const bounds = expandWordAround(textNode, collapsed.startOffset);
  if (!bounds || bounds.end <= bounds.start) return null;
  return asOwnedRange(textNode, bounds);
}

function asOwnedRange(node: Text, bounds: { start: number; end: number }): Range {
  const range = node.ownerDocument!.createRange();
  range.setStart(node, bounds.start);
  range.setEnd(node, bounds.end);
  return range;
}

/** Expand a caret over the surrounding letter/number run ("word" for both CJK and Latin). */
export function expandWordAround(node: Text, offset: number): { start: number; end: number } | null {
  const text = node.textContent ?? "";
  if (offset < 0 || offset > text.length) return null;
  const isLetter = (character: string) => /[\p{L}\p{N}]/u.test(character);
  let start = offset;
  let end = offset;
  if (offset < text.length && isLetter(text[offset]!)) {
    while (end < text.length && isLetter(text[end]!)) end += 1;
    while (start > 0 && isLetter(text[start - 1]!)) start -= 1;
  } else if (start > 0 && isLetter(text[start - 1]!)) {
    while (start > 0 && isLetter(text[start - 1]!)) start -= 1;
    end = start;
    while (end < text.length && isLetter(text[end]!)) end += 1;
  } else {
    // Landed on punctuation: take the single character under the finger so
    // a quote or dash can still be marked deliberately.
    if (offset >= text.length) return null;
    start = offset;
    end = offset + 1;
  }
  // A programmatic selection cannot be extended (no native handles), so cap
  // dictionary-less CJK runs at a phrase-sized window centred on the finger.
  const isHan = (character: string) => /\p{Script=Han}/u.test(character);
  if (end - start > MAX_UNADJUSTABLE_CHARS && text.slice(start, end).split("").some(isHan)) {
    start = Math.max(start, Math.min(offset - Math.floor(MAX_UNADJUSTABLE_CHARS / 2), end - MAX_UNADJUSTABLE_CHARS));
    end = start + MAX_UNADJUSTABLE_CHARS;
  }
  if (end <= start) return null;
  return { start, end };
}

const MAX_UNADJUSTABLE_CHARS = 10;
