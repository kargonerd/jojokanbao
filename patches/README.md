# Dependency patches

## pdfjs-dist 5.7.284

The reader opts into PDF.js `disableAutoFetch` mode so that a linearized PDF can show its first page from the initial and index ranges. Upstream PDF.js still validates the last page during document initialization and eagerly resolves every top-level page reference; for flat page trees this downloads all page ranges before `loadingTask.promise` resolves.

The local patch makes those two behaviors respect `disableAutoFetch`:

- linearized documents skip the eager last-page validation;
- page dictionaries are resolved when their page is requested, rather than all at once.

Non-linearized PDFs retain the last-page validation. Remove this patch once upstream PDF.js provides equivalent demand-loading behavior.
