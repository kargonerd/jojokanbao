# Reader regression test strategy

Reader uses two complementary test layers so interaction coverage can grow without making pull requests slow.

## Fast UI and logic tests (Vitest + jsdom)

These run on every Reader pull request and should contain most regression cases.

| Area | Test file | Protected behavior |
| --- | --- | --- |
| Routes and shell | `app.test.tsx` | all default redirects, publication cards, desktop/mobile navigation, support and 404 pages |
| Reader page | `readerPage.test.tsx` | PDF URL derivation, loading/errors, date and issue navigation, settings, clarity, zoom, page/hash navigation, share, download and scroll controls |
| Search page | `searchPage.test.tsx` | query restoration, request parameters, highlighted results, sorting, dates, pagination, URL sync, empty/error/retry states |
| Publication data | `publications.test.ts` | archive boundaries, missing dates/years/issues, supplements, sorted/unique sequences and defaults |
| PDF rendering | `pdfViewer.test.tsx` | render scale caps, page virtualization, initial page and zoom/pan behavior |
| PDF transport | `protectedPdf.test.ts` | plain/protected auto detection, Range semantics, demand loading and restored downloads |
| Shared controls | `packages/ui/tests/readerControls.test.tsx` | date/month/year/decade navigation, disabled dates, year bounds and outside-click behavior |

Add a jsdom test when behavior can be proven through DOM state, component props, route state or a mocked network boundary. Keep each case focused on one user-visible invariant.

## Browser integration tests (Playwright)

Browser tests are reserved for behavior jsdom cannot prove reliably:

- a real PDF.js worker rendering a canvas from HTTP Range responses;
- first-page demand loading and mobile canvas eviction;
- in-place PDF zoom, pointer panning and browser download;
- dropdown stacking and real scroll containers;
- search request transport and pagination scrolling.

Do not duplicate every jsdom assertion in Playwright. A new E2E test should protect a cross-component or browser-runtime boundary.

## Commands and time budget

```bash
pnpm --filter @jojo/reader... typecheck
pnpm --filter @jojo/reader... test
pnpm --filter @jojo/reader build
pnpm --filter @jojo/reader verify:build
pnpm --filter @jojo/reader exec playwright test
```

The pull-request workflow runs unit/build checks and E2E in parallel. The expected budget is:

- Reader and shared UI Vitest suites: under 15 seconds on CI;
- Playwright execution after browser installation: under 45 seconds;
- total Reader CI wall time: bounded by the eight-minute job timeout, normally around two minutes or less.

If a browser case becomes slow, first move DOM-only assertions to Vitest. Do not weaken the behavior being protected merely to meet the budget.
