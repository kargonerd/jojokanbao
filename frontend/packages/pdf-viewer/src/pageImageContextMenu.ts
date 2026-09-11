/** Let native image actions reach the canvas without disabling text selection. */
export function bindPageImageContextMenu(
  pageContainer: HTMLDivElement,
  textLayerOverlay: HTMLDivElement,
): () => void {
  const document = pageContainer.ownerDocument;
  const controller = new AbortController();
  const { signal } = controller;
  let suspended = false;
  let previousPointerEvents = "";

  const restore = () => {
    if (!suspended) return;
    textLayerOverlay.style.pointerEvents = previousPointerEvents;
    suspended = false;
  };

  pageContainer.addEventListener("pointerdown", (event) => {
    restore();
    const isContextClick = event.button === 2 || (event.button === 0 && event.ctrlKey);
    if (!isContextClick) return;
    const selection = document.getSelection();
    if (selection && !selection.isCollapsed) return;

    // Hit testing for contextmenu happens after pointerdown. Hide only the
    // text overlay from hit testing so the browser exposes its canvas actions.
    previousPointerEvents = textLayerOverlay.style.pointerEvents;
    textLayerOverlay.style.pointerEvents = "none";
    suspended = true;
  }, { capture: true, signal });

  // CopyImageAt / SaveImageAt hit-test again when the user chooses a native
  // menu item. Keep the canvas accessible across pointerup, timers and blur;
  // restore selection only when input returns to the document or on cleanup.
  document.addEventListener("pointermove", (event) => {
    if (event.buttons === 0) restore();
  }, { signal });
  document.addEventListener("pointerdown", (event) => {
    if (!pageContainer.contains(event.target as Node)) restore();
  }, { capture: true, signal });
  document.addEventListener("keydown", restore, { signal });
  // A native menu can consume Escape's keydown but return keyup to the page.
  document.addEventListener("keyup", restore, { signal });
  document.addEventListener("pointercancel", restore, { signal });

  return () => {
    controller.abort();
    restore();
  };
}
