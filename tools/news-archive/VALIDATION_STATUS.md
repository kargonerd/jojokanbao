# JOJO News Archive Runner

> **Imported status snapshot.** This file preserves convergence history from
> temporary runner commit `c35e82e`. References to B2 and the temporary runner
> describe the legacy execution environment, not the target storage contract.
> See [README.md](README.md) and [MIGRATION.md](MIGRATION.md) for the active
> design and cutover gates.

Open-source research tooling for building reproducible, resumable news archives
from publicly indexed web snapshots.

This temporary runner repository supports the nonprofit JOJO Platform research
project while the main platform is being prepared for open-source release.

## Current scope

The generic pipeline supports these publisher adapters:

- AP News
- The Wall Street Journal
- Bloomberg
- The New York Times
- Reuters
- Financial Times
- Axios
- NPR
- Nikkei
- Lianhe Zaobao
- Al Jazeera
- South China Morning Post
- Caixin

The Caixin adapter remains available for archival compatibility, but new
Caixin catalog and parser-validation dispatches are intentionally paused.
Existing Caixin catalogs, holdouts, and raw objects are retained; this pause
does not delete historical data.

The archive is intentionally split into two independent stages:

1. **Raw capture** discovers archive candidates and stores the selected original
   HTML response plus provenance metadata. It does not parse the article or
   download images.
2. **Versioned parsing** replays a raw capture into `jojo-article/1`, preserving
   ordered content blocks and classifying image references before any image is
   selected for archival.

This lets parser changes run against stable source bytes without repeatedly
requesting the upstream archive.

## What is public

- Downloader, discovery, parser, and storage source code
- Tests and GitHub Actions workflows
- JSON Schemas for raw captures and normalized articles
- Snapshot URL manifests and archive metadata

## What stays private

Downloaded HTML, normalized article bodies, images, and SQLite checkpoints are
written to a B2 bucket that the workflow verifies is private. Downloaded content
is never committed to Git and is not uploaded as a GitHub Actions artifact.

## Storage and workflow

The generic `News raw archive` workflow:

1. Restores its Wayback discovery and raw-capture checkpoints from B2.
2. Advances a bounded discovery or capture batch.
3. Uploads immutable, content-addressed raw HTML and capture records.
4. Uploads the SQLite checkpoint last.
5. Optionally dispatches the next bounded run.

See [LEGACY_B2_LAYOUT.md](LEGACY_B2_LAYOUT.md) for the imported schema, storage
layout, local commands, and legacy GitHub Actions inputs.

For the optional archive transport pool, add a freshly issued
`CLASH_SUBSCRIPTION_URL` as a repository Actions secret. The workflow never
stores that URL in Git or B2; it downloads it only at runner startup and keeps
the existing archive request limits in place.

The older Bloomberg-only downloader remains for migration and regression
testing, but new archives use the capture-only pipeline.

## Parser convergence roadmap

The temporary runner remains the active home while validation is in progress.

- Operational TODO: both scheduled watchdog workflows are temporarily
  disabled because GitHub schedules execute the default `main` branch, whose
  queues predate this reduced media set. Re-enable them only after this PR (or
  an equivalent queue-only backport) reaches the default branch. Explicit
  feature-branch validation jobs continue through their own `auto_continue`
  chain meanwhile.

- Completed baseline: Bloomberg.
- Active convergence is being advanced explicitly by publisher/year while the
  watchdog remains disabled on the default branch. Bloomberg's completed
  cells no longer occupy validation slots; the branch watchdog now admits all
  remaining in-scope publishers and filters each year by source capacity.
- A cell counts as converged only when its 800-row summary and parser-bound
  content audit both pass, plus the zero-overlap rotation audit for holdouts.
  Failed content audits keep their checkpoint, raw HTML, and audit evidence in
  B2 but are quarantined from automatic retries until the parser or QA policy
  changes.
- FT 2016 `holdout-v9` and FT 2017 `holdout-v8` formally converged on the
  previous `ft-parser/0.8.42`, but their evidence is now historical. The
  current parser is now `ft-parser/0.8.49`, which removes residual `Sign in`
  paragraphs and buttons plus the FT Business School briefing CTA found in
  the 2020 audit; fresh `holdout-v11` runs for
  FT 2016--2020 v11 runs are historical while the current parser is being
  revalidated. The v11 2019 rotation formally converged at 800/800 with QA
  100%, zero parser errors, zero prior/exclusion overlap, zero hard content
  anomalies, and three non-hard review candidates. Its 2018 and 2020 partial
  audits exposed a legacy “most thought-provoking online contributions” footer;
  `ft-parser/0.8.46` removes it with a regression fixture. The v12 2020
  partial audit then exposed two additional legacy-interface cases (Lex
  contact/subscription boilerplate and underscore-only separators); both are
  now covered by regression tests, and fresh zero-overlap `holdout-v13`
  replays for 2016--2020 were superseded by the current-version rotation. It follows fixes for legacy
  podcast RSS chrome, a flattened JSON-LD related-story tail, dead
  expander/video controls, an AMP ``Read more`` link group, and FT brand
  favicons and v3 open-graph branding found during partial content audits.
  All superseded FT cohorts remain mandatory exclusions. The 2016 holdout
  finished at 800/800 with QA 100%, zero parser errors, zero prior/exclusion
  overlap, zero hard content anomalies, and all 800 extraction statuses
  complete; its content audit retained 905 selected images. The 2017 audit
  retained 794 selected images. The parser fixes covered legacy podcast RSS
  chrome, a flattened JSON-LD related-story tail, dead expander/video
  controls, an AMP ``Read more`` link group, and FT brand favicons and v3
  open-graph branding found during partial content audits.
  The current-parser `holdout-v13` 2019 cell has now also passed both formal
  gates: 800 current evaluations, zero prior/exclusion overlap, zero hard
  anomalies, and 800 audited rows (799 complete and one allowed partial).
  Its audit retained 628 selected images and left two non-hard review
  candidates; the other v13 cells remain in progress.
  The v13 2018 content audit then exposed a standalone `Subscribe` interface
  paragraph in an Infini-News-derived access shell. `ft-parser/0.8.47` removes
  that exact chrome and marks the recognizable no-prose Infini access shell as
  truncated; its regression fixture and the full 1,055-test suite pass. The v14
  2020 audit then exposed a split two-paragraph `Coronavirus business update`
  newsletter promo; `ft-parser/0.8.49` removes that interface pair with a
  regression fixture. Fresh zero-overlap `holdout-v15` replays for 2016--2020
  are now running as the fresh zero-overlap `holdout-v16` cohort on the patched
  parser. The current `.49` FT 2016 `holdout-v16` replay has now formally
  converged: 800/800 audited complete rows, QA 100%, zero parser errors, zero
  prior/exclusion overlap, zero hard content anomalies, and 272 selected images
  (one non-hard repeated-block review candidate); the other v16 cells remain in
  progress and are not counted until both formal gates pass.
  The archive client now enforces a wall-clock limit over each complete
  streamed response, rather than limiting only individual socket reads, so a
  slow-trickling replay cannot occupy a validation worker indefinitely. FT's
  first validation pass probes only the first manifest snapshot per URL;
  retry continuations exhaust the remaining snapshots and staged secondary
  archives.
  The FT Infini-News direct catalog also contains recurring access-shell titles
  such as ``All the benefits of Premium Digital, plus:`` and ``Register to
  read: Financial Times``. The capture filter now excludes these title-only
  shells before network capture (commit `56440b1`), while retaining their
  source rows and raw evidence; subsequent FT continuations use the narrower
  candidate pool. The validation planner also excludes those same title-only
  Infini rows from direct-provider samples, so they cannot consume a holdout
  slot even when a previous checkpoint already contains them.
- Axios's current parser is `axios-parser/0.1.31`, after fixes for partner
  financial-newsletter CTAs, short quote-card attributions, malformed URL
  aliases, legacy Draft.js `Read more` headings, and the historical
  ``Sign up for the New Axios Space newsletter`` CTA. The earlier `holdout-v16`
  rotations for 2017--2023 used `axios-parser/0.1.23` and are now historical,
  not current convergence evidence. That cohort exposed the newsletter CTA in
  the 2019 audit, plus a standalone YouTube subscription CTA in the 2026 audit
  (including list-item markup). The 2026 `holdout-v43` audit then found a
  punctuation-spaced `Subscribe to our YouTube .` variant; `axios-parser/0.1.24`
  removes that exact whitespace form and requires fresh zero-overlap replays.
  The current-parser `holdout-v115` 2017 content audit then exposed a legacy
  Draft.js CTA whose linked ``here`` text was split as ``h ere``:
  ``Subscribe to our newsletters here and check out our news stream here.``
  `axios-parser/0.1.25` removes that exact normalized interface block with a
  regression fixture. All prior `0.1.24` audits are now historical. A fresh
  `.25` replay exposed an Axios 2018 legacy article separator consisting only
  of underscores; `axios-parser/0.1.26` removes that visual rule for Axios and
  adds a regression fixture. All `.25` replays are now historical and fresh
  zero-overlap `.26` cohorts must replace them before any year is counted
  again. The fresh zero-overlap `.26` `holdout-v132` replay for 2017 has now
  formally converged: 800/800 audited and complete, QA 100%, zero parser
  errors, zero prior/exclusion overlap, zero hard content anomalies, and 673
  selected images. The fresh `.26` `holdout-v137` replay for 2023 has now also
  formally converged: 800/800 audited and complete, QA 100%, zero parser
  errors, zero prior/exclusion overlap, zero hard content anomalies, and 992
  selected images (one non-hard repeated-block review candidate). The
  fresh `.26` `holdout-v134` replay for 2020 has now also formally converged:
  800/800 audited complete rows, QA 100%, zero parser errors, zero prior or
  exclusion overlap, zero hard content anomalies, and 957 selected images.
  Its only review candidate is a non-hard repeated-block group containing
  genuine ``what they're saying:`` labels and editor-update notices.
  The same current-parser rotation has now formally converged for 2019
  (`holdout-v133`), 2021 (`holdout-v135`), and 2022 (`holdout-v136`): each
  has 800 audited complete rows, zero parser errors, zero prior/exclusion
  overlap, zero hard content anomalies, and only non-hard repeated-block
  review candidates. The same `.26` contract has now also converged for 2018
  (`holdout-v131`): 800/800 audited complete rows, QA 100%, zero parser
  errors, zero prior/exclusion overlap, zero hard content anomalies, and 867
  selected images. The 2026 replay (`holdout-v140`) has likewise converged:
  800/800 audited complete rows, QA 100%, zero parser errors, zero
  prior/exclusion overlap, zero hard content anomalies, and 932 selected
  images (two non-hard review candidates).
  The fresh `.26` 2025 replay (`holdout-v139`) has also formally converged:
  800/800 audited complete rows, QA 100%, zero parser errors, zero
  prior/exclusion overlap, zero hard content anomalies, and 950 selected
  images (two non-hard review candidates). The fresh `.26` 2024 replay
  (`holdout-v138`) has now formally converged as well: 800/800 audited
  complete rows, QA 100%, zero parser errors, zero prior/exclusion overlap,
  zero hard content anomalies, and 904 selected images (one non-hard
  repeated-block review candidate). 2016 remains source-limited.
  The
  validation workflow now merges the existing Axios Common Crawl catalog with
  the Sitemap/Wayback catalog for future continuation batches.
  earlier `.25` `holdout-v121` replay for 2017 and `holdout-v125` replay for
  2021 had formally converged (802/800 and 801/800 respectively), but both
  are now historical because `.26` changes the parser contract; their audit
  evidence remains preserved in B2 and must not be counted for current
  convergence.
  The superseded `0.1.24` replays for 2018, 2024, 2025, and 2026 had passed
  both gates before this defect was found, but they are retained only as
  historical evidence; fresh `.26` rotations must pass before those years are
  counted again.
  A later independent 2021 cohort (`holdout-v255`) exposed five groups of
  child URLs from Axios deep-dive packages that all parsed as the package's
  first chapter. Axios embeds every chapter in one `__NEXT_DATA__` payload;
  `axios-parser/0.1.31` now matches the structured story permalink to the
  requested canonical URL instead of selecting the first story object. All 13
  affected real captures replay with distinct bodies, so every earlier Axios
  pass is now historical and fresh zero-overlap `.31` cohorts are required.
- Caixin 2013 holdout-v1 has formally converged at 800/800 on
  `caixin-parser/0.1.9` with QA revision 1, zero prior-cohort overlap, zero
  hard content anomalies, and all 228 selected images preserved. The parser
  removes the legacy Two Sessions topic-recirculation tail exposed by the
  initial 751-article audit. Caixin 2014 holdout-v1 has also formally
  converged at 800/800 with zero prior-cohort overlap, zero hard content
  anomalies, and all 3 selected images preserved. Caixin 2015 holdout-v1 has
  now formally converged at 800/800 on the same parser and QA revision, with
  zero prior-cohort overlap, zero hard content anomalies, and 2 selected
  images preserved (one non-hard review candidate). These first holdouts had
  no earlier cohort, so their rotation audits correctly treated the prior
  union as empty. Every currently queued Caixin year has at least 3,901
  candidates. The first bounded 2016--2026 catalog
  pass found at least 1,144 candidates in every year except 2018. A focused
  Common Crawl supplement now adds 3,068 independently cataloged 2018 URLs,
  making every 2016--2026 year eligible for an initial 800-article cohort.
  Caixin 2018 `holdout-v1` has now formally converged on
  `caixin-parser/0.1.10`: 800/800 QA-passing rows, zero parser errors, zero
  prior/exclusion overlap, zero hard content anomalies, and all 800 audited
  extraction statuses complete. No article images were selected by this
  parser, and one non-hard review candidate remains.
  Caixin 2010 had only 580 accepted current-cohort articles after exhausting
  its 940 eligible primary candidates. Its resumable Common Crawl supplement
  now prioritizes recent indexes: 40 high-yield pages found 1,220 URLs,
  including 404 new article-desk URLs absent from the primary manifest. The
  2010 and 2011 have now formally converged at 800/800 with zero
  prior-cohort overlap and zero hard content anomalies. The 2010 run also
  screened 41 photo/video desk pages outside the article target; the merged
  pool exposed 1,708 eligible candidates. The 2011 run had 2,301 eligible
  candidates. Caixin 2012 has also formally converged at 800/800 with zero
  parser errors and zero hard content anomalies; all 29 selected images were
  preserved. Keep completing both broader resumable catalogs for future
  zero-overlap rotations. After the separator fix, Caixin 2017 has now also
  passed the current `caixin-parser/0.1.10` validation at 800/800 with zero
  parser errors, zero hard content anomalies, and 22 selected images. The
  fresh independent `holdout-v48` rotation for 2017 has now formally
  converged as well: 800/800 QA-passing rows, zero parser errors, zero
  prior/exclusion overlap, zero hard content anomalies, and 25 selected
  images (one non-hard review candidate).
  Caixin 2019's fresh zero-overlap `holdout-v1` has now formally converged on
  the same parser: 800/800 QA-passing rows, zero parser errors, zero
  prior/exclusion overlap, zero hard content anomalies, and 4 selected images
  (one non-hard review candidate).
  Caixin 2020's fresh zero-overlap `holdout-v1` has now also formally
  converged on `caixin-parser/0.1.10`: 800/800 QA-passing rows, zero parser
  errors, zero prior/exclusion overlap, zero hard content anomalies, and 10
  selected images (one non-hard review candidate).
  Caixin 2021's fresh zero-overlap `holdout-v1` has now also formally
  converged on the same parser: 800/800 QA-passing rows, zero parser errors,
  zero prior/exclusion overlap, zero hard content anomalies, no selected
  article images, and one non-hard review candidate.
  Caixin 2022's fresh zero-overlap `holdout-v1` has now also formally
  converged on the same parser: 800/800 QA-passing rows, zero parser errors,
  zero prior/exclusion overlap, zero hard content anomalies, and 470 selected
  images (two non-hard review candidates).
  Caixin 2023's fresh zero-overlap `holdout-v1` has now also formally
  converged on the same parser: 800/800 QA-passing rows, zero parser errors,
  zero prior/exclusion overlap, zero hard content anomalies, and 816 selected
  images (two non-hard review candidates).
  Caixin 2024's fresh zero-overlap `holdout-v1` has now also formally
  converged on `caixin-parser/0.1.10`: 800/800 QA-passing rows, zero parser
  errors, zero prior/exclusion overlap, zero hard content anomalies, and 817
  selected images (two non-hard review candidates). Caixin 2025 has likewise
  formally converged at 800/800 with the same parser and gates, retaining 718
  selected images (two non-hard review candidates).
  Caixin 2026's fresh zero-overlap `holdout-v47` has now also reached the
  formal current-parser gate: 800/800 QA-passing rows, zero parser errors,
  zero prior/exclusion overlap, zero hard content anomalies, and all 800
  extraction statuses complete on `caixin-parser/0.1.10`.
  The earlier 2010--2015 holdouts used older parser versions; fresh current
  `caixin-parser/0.1.10` rotations for all six years were run against
  the 3,901--5,996 candidate Wayback windows (with the 2010 Common Crawl
  supplement available as an additional source). A fresh `holdout-v8` is
  replacing those superseded cohorts: all six years 2010--2015 have now
  passed both content and zero-overlap audits at 800/800 on
  `caixin-parser/0.1.10` after the Common Crawl/Wayback candidate merge.
- WSJ remains source-limited in the older 2020 cell (the current checkpoint
  has 797 complete rows after 826 evaluations); that cell is kept as a
  recorded TODO until its candidate pool is enlarged. `wsj-parser/0.8.55`
  removes the flattened `related stories` interface marker. QA revision 2
  additionally excludes Infini-News media-only shells that explicitly say
  `Article Not Supported` and `To Read the Full Story`, while retaining their
  raw captures. Current 0.8.55 zero-overlap audits have now passed for 2016,
  2018, 2019, 2021, and 2022 at 800+ rows with zero hard anomalies; the 2013
  cell remains source-limited. The earlier zero-overlap `holdout-v10` replay
  for 2020 was cancelled at 435/800 complete rows and is not convergence
  evidence. A fresh zero-overlap `holdout-v11` replay against
  `wsj-parser/0.8.55` was then checkpoint-bounded and cancelled after its
  1,489 eligible candidates produced 1,471 archive/paywall-shell failures and
  zero valid captures; its raw checkpoint and failure evidence are retained as
  a source-capacity TODO, not convergence evidence. The first pass tried one
  manifest snapshot per URL with a short timeout, while continuation batches
  were prepared to revisit all snapshots and enable timemap/secondary-archive
  fallbacks, preventing transient Wayback 503s from occupying every worker.
  The later current-parser 2013 holdout reached 800/800, but its content audit
  found three flattened Best of the Web subscription prompts, two legacy
  MSN/WSJ panels with no surviving story node, and two URL-alias duplicate
  pairs. `wsj-parser/0.8.68` removes the exact newsletter CTA, marks the
  article-less legacy panel as truncated/non-article raw evidence, and
  normalizes encoded-whitespace URL aliases. Validation also records WSJ's
  stable `articleId`, so slug and legacy `SB...` aliases cannot occupy two
  independent sample slots. The failed 0.8.67 cohort remains exclusion
  evidence; fresh zero-overlap 0.8.68 rotations supersede all prior WSJ cells.
  The later `0.8.72` 2018/2020 audits reached 800 complete rows but exposed
  three AMP-era body leaks: a metered preview duplicated the opening and
  ended in `The...`, camel-case `bylineWrap` metadata appeared as prose, and
  Coronavirus/newsletter link cards survived inside generic rich-text
  insets. `wsj-parser/0.8.73` removes the preview only when the complete
  `amp-access` body is present, strips that exact byline wrapper, and removes
  the two structurally identified link cards. Exact replay preserves genuine
  inline-video straps such as `From the Archives` and `Earlier`. All `.72`
  evidence is superseded; fresh zero-overlap `.73` cohorts are required.
  The format-4 audit of WSJ 2021 `holdout-v295` subsequently found two more
  legacy AMP presentation leaks: `.wsj-ad` disclaimers and
  `.newsletter-inset` signup cards were flattened into body paragraphs, while
  a fixed `im-273836` house illustration labelled only `WSJ` was selected in
  unrelated articles. `wsj-parser/0.8.74` removes those exact structures and
  asset, while retaining genuine contextual video straps. All `.73` evidence,
  including the apparent 2021 pass, is superseded; every WSJ target year now
  requires a fresh zero-overlap `.74` cohort.
  The format-6 WSJ 2020 replay then found a `Stay Informed` coronavirus
  newsletter module inside an AMP `.media-object-rich-text` wrapper. The same
  review showed QA-5 screening long, fully recovered 2022 articles merely
  because hidden source chrome retained an unsupported-media notice.
  `wsj-parser/0.8.75` removes the structurally identified newsletter card;
  QA-6 limits the unsupported-media screen to bodies shorter than 200
  characters. All `.74` evidence is superseded and must rotate to fresh,
  zero-overlap `.75` cohorts.
  Before `.75` accrued validation state, manual review of the superseded 2021
  audit found 20 standalone `The...` fragments. Those pages use newer AMP
  `subscriptions-section=content/content-not-granted` attributes instead of
  `amp-access`. `wsj-parser/0.8.76` recognizes both schemes and removes only
  the metered snippet when the complete sibling is present; `.76` therefore
  replaces `.75` as the required fresh cohort version.
- NYT 2019 `holdout-v2` has formally converged at 800/800 on
  `nyt-parser/0.8.62`: QA 100%, zero parser errors, zero prior/exclusion
  overlap, and all 800 content-audit rows complete with zero hard anomalies.
  The audit retained 1,016 selected images and left one review candidate.
  A fresh zero-overlap `holdout-v6` for NYT 2020 has now formally converged
  on `nyt-parser/0.8.64`: 800/800 QA-passing rows, zero parser errors, zero
  prior/exclusion overlap, all 800 extraction statuses complete, and zero hard
  content anomalies. The audit retained 1,852 selected images and left two
  non-hard review candidates.
  The earlier broad rotation used `nyt-parser/0.8.73`: it filters legacy
  newsgraphics sprite sheets (including the GIF flag sprite found in the 2016
  audit) and standalone `Related` recirculation markers,
  chooses the substantive body when a modern interactive contains a short
  results panel before the main prose, and removes flattened Campaign Reporter
  and Climate Forward newsletter subscription CTAs, including heading-level
  interactive CTAs and dead `Next:` controls. The 0.8.68 `holdout-v15` replay
  exposed the latter CTA in a 2025 article; the 0.8.69 `holdout-v16` replay
  then exposed the heading CTA in 2018 and dead interactive control in 2019.
  The 0.8.70 `holdout-v17` audit also exposed decorative `healthquiz-art`
  responsive images being archived as editorial media. The 0.8.72
  `holdout-v19` audit then exposed a Space and Astronomy Calendar CTA in the
  2023 interactive. Fresh zero-overlap `holdout-v20` runs for 2016--2026 have
  now been dispatched on 0.8.73, and all earlier NYT evidence remains
  historical until these audits pass. The 2021 v20 continuation reached 797
  complete rows but its final rotation audit found one missing historical
  exclusion entry, so it is not convergence evidence; a fresh zero-overlap
  `holdout-v22` replay for 2021 reached 783/800 complete rows, but its final
  rotation audit still found one missing historical exclusion entry; it is not
  convergence evidence. The exclusion importer now requires sample and result
  years to match (with a regression test for the stale cross-year URL), and a
  fresh zero-overlap `holdout-v23` replay now has final B2 evidence passing
  the formal 800-row content gate on
  `nyt-parser/0.8.73` (800 audited QA-passing rows, zero hard anomalies) and
  the zero-overlap rotation gate (809 current captures, zero prior/exclusion
  overlap, no missing historical exclusions). The audited cohort contains
  799 complete rows and one explicitly marked incomplete interactive; the
  extra rejected capture is an NYT ``Editors' Note`` page stating that the
  article was published prematurely, not recoverable article prose. It is
  retained in raw storage and is not counted among the 800 QA-passing rows.
  The current-parser `holdout-v20` replay for NYT 2025 has also passed both
  gates at 800 audited rows, with zero hard anomalies, zero overlap, and no
  missing historical exclusions.
  The current-parser `holdout-v20` replay for NYT 2020 has now also passed
  both gates: 800/800 QA-passing complete rows, zero parser errors, zero hard
  anomalies, two non-hard review candidates, and zero prior/exclusion overlap.
  NYT 2018 has now completed the fresh zero-overlap `holdout-v11` on
  `nyt-parser/0.8.64`: 800/800 QA-passing rows, zero parser errors, zero
  prior/exclusion overlap, and all 800 extraction statuses complete with zero
  hard content anomalies. The final audit retained 1,023 selected images and
  left one non-hard review candidate. This supersedes the earlier 2018
  `holdout-v9` evidence after the interactive-sprite and Campaign Reporter
  content-audit fixes.
  The older NYT 2018 `holdout-v7` reached 800/800 on `nyt-parser/0.8.58`
  without the current content-audit gate. The `holdout-v8` replay reached
  800 QA-passing rows after evaluating 801, but one archived `/admin/` teaser
  prevented the 100% QA gate. QA revision 2 now screens such unrecoverable
  teasers as `nonarticle-desk`. The fresh `holdout-v9` has now converged at
  800/800 under that policy: zero parser errors, zero prior/exclusion overlap,
  zero hard content anomalies, and all 800 extraction statuses complete; its
  content audit retained 962 selected images.
  Subsequent year-by-year independent rotations advanced the NYT parser to
  `nyt-parser/0.8.101`. NYT 2017 `holdout-v227` has now formally converged on
  that version: 801 current QA-passing complete rows, zero parser errors,
  800 content-audited rows with zero hard anomalies, and zero overlap against
  the 7,200 formally evaluated rows in the nine preceding 2017 cohorts. The
  audit retained 1,109 selected images. Its two non-hard review groups were
  manually confirmed as genuine Briefing/letters section headings and shared
  event imagery. B2 contains all 1,622 raw/record files for the 811 result
  rows, with zero remote-check differences, plus the compressed checkpoint
  and complete convergence evidence under `holdout-v227/nyt/2017/state`.
  Subsequent independent 2018 rotations exposed and fixed legacy WRAL
  syndication chrome, Opinion cartoons whose image lived outside
  `articleBody`, prose-backed Fashion Week slideshows, and linked slideshows
  whose archived per-slide payloads were empty. The fresh zero-overlap
  `holdout-v234` rotation now formally converges on `nyt-parser/0.8.107`:
  801 current QA-passing complete rows after 820 captures, zero parser
  errors, zero prior/exclusion overlap, and a content audit of 800 complete
  rows with zero hard anomalies. Its audit retained 1,123 selected images;
  the only review group contains genuine letters-to-the-editor headings.
  The raw objects, best-version capture records, compressed checkpoint, and
  both formal audits are preserved in B2.
  NYT 2019 then exposed newsletter engagement copy in `holdout-v235` and
  real-estate/arts recirculation copy in the independent `holdout-v236`.
  After both fixes, the fresh zero-overlap `holdout-v237` formally converges
  on `nyt-parser/0.8.109`: 801 QA-passing complete rows after 815 evaluated
  captures, zero parser errors, zero prior/exclusion overlap, and 800
  content-audited rows with zero hard anomalies. The audit retained 1,216
  selected images. Its sole non-hard review group was manually confirmed as
  genuine letters-to-the-editor and television-column section headings.
  The current local `nyt-2020-v248` rotation advances the parser to
  `nyt-parser/0.8.120` after fixing a modern election-results regression: NYT
  renders mobile and desktop `Latest updates` recirculation rails before and
  after the result tables, so removing the first heading used to delete the
  substantive tables. The parser now removes only those reporter-update
  containers. The fresh holdout has 813 evaluated rows (805 QA-passing, with
  eight explicitly screened non-article corrections/quotation pages), zero
  parser errors, zero prior/exclusion overlap, and no missing historical
  exclusions. The formal 800-row content audit reports all extraction
  statuses complete, zero hard anomalies, and 1,700 selected images; its two
  review groups are the expected shared election/briefing imagery and repeated
  section labels. The v248 raw-object/record delta and the compact manifest,
  checkpoint, rotation audit, and content audit are now published under the
  canonical NYT source root and `news-archive/v2/validation-state/holdout-v248`.
- AP 2012 `holdout-v1` has formally converged at 800/800 on
  `ap-parser/0.6.21`: QA 100%, zero parser errors, zero prior/exclusion
  overlap, zero hard content anomalies, and all 800 extraction statuses
  complete. Its content audit retained 383 selected images and two review
  candidates. AP 2013 has now also formally converged at 800/800 with QA
  100%, zero parser errors, zero prior/exclusion overlap, zero hard content
  anomalies, and all 800 extraction statuses complete; its content audit
  retained 13 selected images. AP 2014 has now formally converged at 800/800
  on the same parser and sitemap shard, with QA 100%, zero parser errors,
  zero prior/exclusion overlap, zero hard content anomalies, and all 800
  extraction statuses complete; its content audit retained 41 selected
  images. AP 2015 has now formally converged at 800/800 on the same parser
  and sitemap shard, with QA 100%, zero parser errors, zero prior/exclusion
  overlap, zero hard content anomalies, and all 800 extraction statuses
  complete; its content audit retained 91 selected images and left one
  non-hard review candidate. The AP 2010 catalog
  currently exposes fewer than 800 distinct candidates; 2012 and later years
  have materially larger pools and are being validated first. AP 2016 has now
  completed the current `ap-parser/0.6.21` validation at 800/800 QA-passing
  rows, with zero parser errors, all 800 extraction statuses complete, zero
  hard content anomalies, and 17 selected images (one non-hard review
  candidate). AP 2017 has now also formally converged at 800/800 on the same
  parser: QA 100%, zero parser errors, zero prior/exclusion overlap, zero hard
  content anomalies, all 800 extraction statuses complete, and 62 selected
  images (one non-hard review candidate); this is historical evidence for
  `ap-parser/0.6.21`. AP 2016 has now also formally converged on
  `ap-parser/0.6.22` at 800/800: QA 100%, zero parser errors,
  zero prior/exclusion overlap, zero hard content anomalies, all extraction
  statuses complete, and 21 selected images (one non-hard review candidate).
  A fresh audit of AP 2017 on `ap-parser/0.6.22` has now also formally
  converged at 800/800: QA 100%, zero parser errors, zero prior/exclusion
  overlap, zero hard content anomalies, all extraction statuses complete, and
  77 selected images (one non-hard review candidate).
  AP 2018's first content audit found
  one legacy inline `RELATED` interface marker. The parser now removes that
  marker as `ap-parser/0.6.22`; fresh zero-overlap `holdout-v1` evidence has
  formally converged at 800/800: QA 100%, zero parser errors, zero prior or
  exclusion overlap, zero hard content anomalies, all extraction statuses
  complete, and 56 selected images (two non-hard review candidates).
  A fresh zero-overlap `holdout-v2` rotation for AP 2019 has now formally
  converged on `ap-parser/0.6.24` after the earnings-page interactive-control
  fix: 800 QA-passing rows, zero parser errors, zero prior/exclusion overlap,
  zero hard content anomalies, all 800 extraction statuses complete, and 140
  selected images (one non-hard review candidate).
  A fresh zero-overlap `holdout-v3` rotation for AP 2020 has now also formally
  converged on the same parser: 800 QA-passing rows, zero parser errors, zero
  prior/exclusion overlap, zero hard content anomalies, all 800 extraction
  statuses complete, and 309 selected images (one non-hard review candidate).
  AP 2021's fresh zero-overlap `holdout-v3` has now also formally converged on
  `ap-parser/0.6.24`: 800 QA-passing rows, zero parser errors, zero
  prior/exclusion overlap, zero hard content anomalies, all 800 extraction
  statuses complete, and 466 selected images (two non-hard review candidates).
  AP 2022's fresh zero-overlap `holdout-v3` has now also formally converged on
  the same parser: 800 QA-passing rows, zero parser errors, zero
  prior/exclusion overlap, zero hard content anomalies, all 800 extraction
  statuses complete, and 455 selected images (two non-hard review candidates).
  AP 2023's fresh zero-overlap `holdout-v4` has now formally converged on
  `ap-parser/0.6.25`: 800/800 QA-passing rows, zero parser errors, zero
  prior/exclusion overlap, zero hard content anomalies, all 800 extraction
  statuses complete, and 2,132 selected images (eight non-hard review
  candidates).
  AP 2024's fresh zero-overlap `holdout-v4` has now formally converged on
  `ap-parser/0.6.25`: 800 QA-passing rows, zero parser errors, zero
  prior/exclusion overlap, zero hard content anomalies, all 800 extraction
  statuses complete, and 2,313 selected images (six non-hard review
  candidates).
  Fresh zero-overlap `holdout-v4` rotations for AP 2019 and AP 2022 have now
  also formally converged on `ap-parser/0.6.25`: each reached 800/800 QA,
  zero parser errors and overlaps, zero hard content anomalies, and 800
  complete extraction statuses; the audits retained 189 and 477 selected
  images respectively (one and two non-hard review candidates). AP 2025's
  `holdout-v4` has likewise converged with 1,830 selected images and two
  non-hard review candidates.
  The same fresh `holdout-v4` gate has now formally converged for AP 2017,
  2018, and 2021 on `ap-parser/0.6.25`: each reached 800/800 QA with zero
  parser errors, overlaps, or hard content anomalies; their audits retained
  12, 57, and 496 selected images respectively (one, one, and two non-hard
  review candidates). AP 2025's completed content audit also records the
  current `holdout-v56` as formally converged on `ap-parser/0.6.25`: 800/800
  QA-passing rows, zero parser errors, zero prior/exclusion overlap, zero hard
  content anomalies, all 800 extraction statuses complete, and 1,884 selected
  images (two non-hard review candidates).
  AP 2013--2016 have also passed fresh `holdout-v4` on `ap-parser/0.6.25`:
  each reached 800/800 with zero parser errors, overlaps, or hard content
  anomalies, retaining 32, 46, 53, and 19 selected images respectively.
  AP 2023 has now passed a fresh current-parser `holdout-v217` on
  `ap-parser/0.6.27`: 800/800 complete QA-passing rows, zero parser errors,
  zero prior/exclusion overlap, zero hard content anomalies, and 749 selected
  images. Manual review confirmed that all repeated text groups are legitimate
  sports/lottery section labels or AP data-source credits, all three repeated
  image groups are editorially relevant to both articles, and the three
  shortest 91--124 character records are complete breaking-news briefs rather
  than truncated bodies.
- Al Jazeera 2019 `validation` has formally converged at 800/800 on
  `aljazeera-parser/0.1.2`: QA 100%, zero parser errors, all 800 extraction
  statuses complete, zero hard content anomalies, and 1,199 selected images.
  That is retained as historical evidence for the pre-0.1.3 parser. A fresh
  `holdout-v1` for 2020 formally converged on `aljazeera-parser/0.1.3` with
  800/800 QA-passing rows, zero parser errors, zero prior/exclusion overlap,
  zero hard content anomalies, 800 complete extraction statuses, and 1,482
  selected images. The 0.1.3 fix removes underscore-only visual separators
  from legacy live-update pages; the 2019 cell must be re-rotated on this
  current parser before it can be considered current-version evidence. A
  follow-up `0.1.4` fix recognizes image-only Al Jazeera gallery snapshots;
  a further `0.1.5` fix also handles legacy gallery shells and heading-only
  live-update separators. The fresh `holdout-v3` rotation for 2019 has now
  formally converged on `0.1.5` at 800/800 with zero parser errors, zero hard
  content anomalies, zero prior overlap, and 1,238 selected images. The
  2017/2020 v3 runs reached 800 QA-passing rows but retained non-clean state
  records, so they are not formal evidence. The fresh `holdout-v4` rotation
  for 2017 has now also formally converged at 800/800, with zero prior
  overlap, zero hard anomalies, and 1,311 selected images. The fresh 2020
  `holdout-v5` rotation has now formally converged on `0.1.5` at 800/800,
  with zero parser errors, zero prior/exclusion overlap, zero hard content
  anomalies, and all 800 extraction statuses complete; its content audit
  retained 1,421 selected images and left two non-hard review candidates.
  The fresh 2018 `holdout-v1` rotation has now also formally converged on
  `aljazeera-parser/0.1.5`: 800 QA-passing rows, zero parser errors, zero
  prior/exclusion overlap, zero hard content anomalies, and 800 complete
  extraction statuses. Its content audit retained 1,299 selected images and
  left two non-hard review candidates; one additional source candidate was
  unsupported and was not part of the 800-row formal sample.
  The fresh 2016 `holdout-v1` rotation has now also formally converged on the
  same parser: 800 QA-passing rows after 810 evaluations, zero parser errors,
  zero prior/exclusion overlap, zero hard content anomalies, and 800 audited
  complete extraction statuses. Its content audit retained 1,503 selected
  images and left two non-hard review candidates.
  QA revision 2 screens short, unrecoverable dynamic LiveBlog shells as
  non-article records while retaining their raw captures. The current-version
  0.1.5 content audits now cover every 2016--2026 year: each reached the
  formal 800-row target with zero hard anomalies and zero parser errors. The
  2016 audit has 798 complete and 2 partial rows; 2023 has 799 complete and
  1 partial row, while the other years have 800 complete rows. Earlier
  pre-0.1.5 evidence remains historical.
- NPR's current parser is now `npr-parser/0.1.49`. The v0.1.31/v0.1.32
  replays exposed legacy podcast, subscription-network, and newsletter CTAs;
  later audits also exposed long podcast/challenge CTAs and legacy `Read more`
  links. The parser removes all of these with regression fixtures. Fresh
  zero-overlap `holdout-v23` rotations are dispatched for 2010--2026 against
  the current parser; all earlier NPR results remain historical until these
  current-version audits pass. The 2019 v23 checkpoint exposed a planner-only
  zero-sample run (the source manifest had candidates but no rows were planned),
  so that year was reissued as `holdout-v24` rather than treated as a parser result.
  QA revision 1 now also screens unrecoverable short NPR audio shells from the
  text-article denominator while retaining their raw captures; the affected
  v23 years are being replayed against that policy. Because the v23 2018 plan
  exhausted at 442 accepted rows, a fresh `holdout-v24` 2018 rotation and a
  `holdout-v25` 2019 rotation were also planner-only zero-sample runs despite
  successful workflow exits. The v26 rotations were likewise planner-only:
  parsed page dates moved samples out of their catalog years. Validation now
  keeps the catalog year unless the canonical URL encodes a stable year;
  fresh zero-overlap `holdout-v27` rotations for 2018 and 2019 were dispatched
  from the fixed runner; the resulting remaining disjoint pools currently
  yield only 30 and 3 accepted rows respectively, so both years are now
  marked source-limited rather than being counted as parser convergence.
  The fresh `holdout-v30` rotations exposed one short NPR newsletter CTA in
  2020; 0.1.39 removed that legacy `subscribe to our newsletter` form. The
  fresh `holdout-v31` rotations then exposed an excerpt copyright tail in
  2013; 0.1.40 removes that exact notice. Fresh zero-overlap `holdout-v32`
  rotations for 2010--2026 were run against the fixed parser. The
  current v32 evidence has already passed 800/800 content and zero-overlap
  audits for 2010, 2012--2015, 2021--2023, and 2025 on 0.1.40; 2024 exposed
  one limited-run sleep-newsletter CTA, so `npr-parser/0.1.41` is being
  replayed in a fresh `holdout-v33` cohort. That replay has now formally
  passed 800/800 for 2015, 2021, 2022, and 2024 on 0.1.41 (zero hard
  anomalies, zero-overlap rotation, and two non-hard review candidates each).
  The 2010, 2013, and 2014 replays have reached 800 and are finishing their
  final audit uploads. The 2023 replay exposed four `Read more:` interface
  labels, so `npr-parser/0.1.42` removes that modern label and a fresh
  `holdout-v34` 2010, 2013--2015, 2021, 2023, and 2024 replays have now formally passed 800/800 on
  0.1.42 with zero hard anomalies and zero-overlap rotation. Additional v34 replays for
  2010, 2013--2015, 2021, 2023--2025 are also formally passing on the current parser;
  2022 currently has 566/800 eligible rows and is source-limited. 2012 remains below
  the target; 2011 and 2020 remain below the target, 2026 requires a fresh v35 replay, and 2016--2019 are
  source-limited in this manifest. The 2012 and 2016 automatic retries were
  stopped after their current v33/v32 plans exposed only 323 and 8 rows
  respectively; they are source-limited, not parser failures.
  A current-parser `holdout-v80` probe for 2020 confirmed the same limitation:
  the manifest contained 12,406 rows but only seven residual incomplete
  candidates and zero source matches were available for replay. The chain was
  stopped without counting it as parser convergence.
  The current-parser `holdout-v78` probe for 2022 likewise found only 11
  previously evaluated rows and one residual incomplete candidate with zero
  source matches; it terminated as source-limited rather than producing a
  false convergence result.
  The fresh 2024 replay exposed one Life Kit playlist icon incorrectly selected
  as editorial artwork; `npr-parser/0.1.46` filters that asset family. The new
  zero-overlap `holdout-v82` replay now passes at 803 evaluated captures,
  800 audited complete rows, zero parser errors, zero prior/exclusion overlap,
  zero hard anomalies, and two non-hard review candidates.
  Because the parser version changed, fresh zero-overlap current-version
  replays for 2021, 2023, 2025, and 2026 have also been queued as
  `holdout-v82` through `holdout-v86`; the earlier 0.1.45 audits remain
  historical until these current-version runs pass.
  The current-parser `holdout-v85` replay for 2021 has now passed at 826
  evaluated captures, 800 audited complete rows, zero parser errors, zero
  prior/exclusion overlap, zero hard anomalies, and two non-hard review
  candidates.
  The current-parser `holdout-v84` replay for 2023 has now also passed at 837
  evaluated captures, 800 audited complete rows, zero parser errors, zero
  prior/exclusion overlap, zero hard anomalies, and two non-hard review
  candidates.
  The current-parser `holdout-v86` replay for 2025 has now also passed at 814
  evaluated captures, 800 audited complete rows, zero parser errors, zero
  prior/exclusion overlap, zero hard anomalies, and two non-hard review
  candidates. The 2026 current-version replay remains in progress.
  That 2026 `.0.1.46` replay subsequently exposed one Body Electric newsletter
  CTA (`sign up for our Body Electric newsletter, or share it with a friend`)
  in its content audit. `npr-parser/0.1.47` removes that exact interface block
  with a regression fixture; fresh zero-overlap `.0.1.47` replays are now
  dispatched as `holdout-v87` through `holdout-v91` for 2026, 2024, 2021,
  2023, and 2025 respectively. The source-capable older cells 2010 and
  2013--2015 are also dispatched as `holdout-v96` through `holdout-v99`; the
  `.0.1.46` passes remain historical until these current-version replays pass
  both gates. The `.0.1.47` 2021 replay (`holdout-v89`) exhausted its
  zero-overlap pool at 163 evaluated/QA-passing rows with no actionable source
  candidates, so that cell is now explicitly source-limited rather than being
  counted as parser convergence. The `.0.1.47` 2024 replay (`holdout-v88`)
  formally passed at 814 evaluated captures and 800 audited complete rows,
  with zero parser errors, zero prior/exclusion overlap, zero hard anomalies,
  and two non-hard review candidates.
  The `.0.1.47` 2025 audit then exposed a Pod Club newsletter CTA
  (`sign up for the Pod Club newsletter: www.npr.org/podclub`).
  `npr-parser/0.1.48` removes that exact interface block with a regression
  fixture. Fresh zero-overlap `.0.1.48` replays are now dispatched as
  `holdout-v100` through `holdout-v108` for 2026, 2024, 2023, 2025, 2010,
  2013, 2014, 2015, and 2021 respectively; all earlier `.0.1.47` results are
  historical until the current-version gates pass or a cell is confirmed
  source-limited.
  The `.0.1.48` 2024 (`holdout-v101`) and 2025 (`holdout-v103`) replays have
  now formally passed: 808 and 806 current-version evaluations respectively,
  zero prior/exclusion overlap, 800 audited complete rows each, zero hard
  content anomalies, and two non-hard review candidates each. The 2014
  replay (`holdout-v106`) has now also formally passed at 854 current-version
  evaluations, 800 audited complete rows, zero prior/exclusion overlap, zero
  hard content anomalies, and two non-hard review candidates. The 2015 replay
  exhausted its disjoint source pool at 453 QA-passing rows with three terminal
  capture errors and is source-limited. The 2026 replay exhausted its available
  pool at 40 evaluated/QA-passing rows, while 2010 reached 350
  evaluated/QA-passing rows; both are source-limited rather than parser
  failures. A fresh current-parser `holdout-v110` replay after the 2010
  Common Crawl hydration pass found only 13 actionable residual rows: eight
  were old template/non-article pages and five ended in capture errors, so it
  remains source-limited rather than parser-limited. The 2021 replay captured 30 pages, all screened as non-article desk
  content, and is likewise source-limited. NPR 2013's Common Crawl supplement
  has now produced 1,726 dated article candidates (2,751 raw candidates), which,
  combined with its primary Wayback pool, is sufficient for a fresh 800-row
  replay; the restarted v105 batch has now merged that catalog and is running
  against a 1,344-row plan. NPR 2023 is continuing while its Common Crawl
  supplement is still being scanned; the
  existing Wayback-only batch has 86 screened non-articles and no evaluated
  article rows. The other current-version cells are still running or
  source-limited.
  The completed v105 audit then found one non-hard repeated-block review
  candidate: NPR's legacy transcript disclaimer appeared in 788 rows. The
  current `npr-parser/0.1.49` removes that paragraph-level template while
  preserving the transcript body. Fresh zero-overlap v109 then formally
  passed for 2013: 800 audited complete rows, 100% QA, zero parser errors,
  zero hard anomalies, and zero prior/exclusion overlap. Its only review
  candidate is a genuine repeated transcript speaker label, not the removed
  disclaimer.
  The current-parser `holdout-v102` replay for 2023 has now also formally
  passed: 800 audited complete rows, 100% QA, zero parser errors, zero hard
  anomalies, and zero prior/exclusion overlap (with two non-hard review
  candidates retained for inspection).
  The fresh `.49` `holdout-v112` replay for 2024 has now also formally
  converged: 821 evaluated captures yielded 800 audited complete rows, 100%
  QA, zero parser errors, zero hard anomalies, zero prior/exclusion overlap,
  and 2,842 selected images (two non-hard review candidates). Fresh `.49`
  `holdout-v113` for 2025 has now formally converged as well: 800 audited
  complete rows, 100% QA, zero parser errors, zero hard anomalies, zero
  prior/exclusion overlap, and 2,673 selected images (two non-hard review
  candidates).
  The `.49` `holdout-v114` replay for 2011 has now formally converged as
  well: 800 audited complete rows, 100% QA, zero parser errors, zero hard
  anomalies, zero prior/exclusion overlap, and 1,175 selected images (two
  non-hard review candidates). NPR 2014 required a same-cohort continuation
  from 799/800 after an automatic-continuation guard incorrectly skipped its
  final one-row batch.
  The resumed `.49` `holdout-v111` replay for 2014 has now formally converged
  at 801 evaluated captures and 800 audited complete rows, with 100% QA, zero
  parser errors, zero hard anomalies, zero prior/exclusion overlap, and 906
  selected images (two non-hard review candidates).
  The v34 2026 replay reached 800/800 with zero parser errors, but its content
  audit exposed a Planet Money newsletter CTA. `npr-parser/0.1.43` removes
  that exact interface block; v34 is superseded and a fresh zero-overlap v35
  2026 replay then exposed a Life Kit newsletter CTA. `npr-parser/0.1.44`
  removes that second exact interface block; the fresh zero-overlap `holdout-v36`
  2026 replay now formally converged at 801/801 QA-passing complete rows, zero
  parser errors, zero prior/exclusion overlap, zero hard content anomalies,
  and two non-hard review candidates.
  The current-parser `holdout-v65` 2025 audit then exposed a Dry January
  newsletter CTA. `npr-parser/0.1.45` removes that exact interface block; a
  fresh zero-overlap `holdout-v74` 2025 replay now passes 800/800 with zero
  parser errors, zero overlap, zero hard anomalies, and two non-hard review
  candidates.
- NPR 2012's fresh zero-overlap `holdout-v14` has now formally converged at
  800/800 on `npr-parser/0.1.26`: QA 100%, zero parser errors, zero prior or
  exclusion overlap, zero hard content anomalies, all 800 extraction statuses
  complete, and 1,276 selected images (two non-hard review candidates). The
  previous failed audit was caused by one Wayback tracking suffix embedded in
  a stored path; manifest import and holdout selection now normalize/reject
  these aliases, with regression tests. NPR 2011's next audit also exposed a
  legacy `Read More` header and one old URL alias; the parser now removes the
  header as `npr-parser/0.1.27`. The fresh zero-overlap `holdout-v15` has now
  formally converged at 800/800: QA 100%, zero parser errors, zero prior or
  exclusion overlap, zero hard content anomalies, all extraction statuses
  complete, and 1,108 selected images (two non-hard review candidates). NPR
  2010's fresh zero-overlap `holdout-v17` has now formally converged on
  `npr-parser/0.1.27`: 800/800 QA-passing rows, zero parser errors, zero
  prior/exclusion overlap, zero hard content anomalies, all 800 extraction
  statuses complete, and 748 selected images (two non-hard review candidates).
  The Common Crawl supplement exposed 12,931 eligible candidates for that
  cohort.
  The current v201 replay for 2013 exposed a real legacy-template defect:
  `_remove_npr_body_chrome` could remove an entire `.transcript` wrapper when
  its first paragraph began with the NPR copyright disclaimer. `npr-parser/0.1.54`
  now limits that cleanup to leaf disclaimer nodes and has a regression test;
  a fresh zero-overlap replay is required before the current parser can be
  considered converged for the affected cohort.
  A stricter raw replay later disproved the apparent NPR 2016 convergence on
  `npr-parser/0.1.56`: legacy `#storytext` streams interleave
  `.bucketwrap.internallink` recommendation cards with article paragraphs, so
  their section slugs, linked headlines, and thumbnails leaked into the body.
  NPR also exposed one photograph as `_wide`, `-s1100`, and `-s1200`
  renditions that were emitted as duplicate images and captions. All NPR
  `0.1.56` evidence, including `holdout-v205` 2011, `holdout-v208` 2012, and
  `holdout-v307` 2016, is therefore superseded; every NPR target year requires
  a fresh zero-overlap cohort on the bumped parser before convergence can be
  claimed again.
- Nikkei's Common Crawl supplement now exposes enough dated candidates for
  2012--2015 (909, 1,055, 915, and 1,085 respectively), and the merged
  2016--2019 windows also have sufficient coverage. Current
  `nikkei-parser/0.1.7` zero-overlap `holdout-v3` runs were dispatched for
  2012--2019; 2020 has only two dated candidates and 2021--2026 have none,
  so those cells are source-limited rather than parser failures. The current
  v3 audits for 2016--2019 have now formally passed 800/800 with zero hard
  anomalies; the 2012--2015 runs remain capture-source limited despite their
  catalog candidate counts. A 2014 state audit found 2,475 rejected captures
  out of 2,495 planned records: the archived HTML is a 200-byte Japanese
  paywall teaser (``［有料会員限定］``), so the parser correctly rejects it as
  unusable article text; the raw candidates are retained and the retry loop
  was stopped rather than re-downloading the same permanent rejection. A
  fresh 2012 probe likewise rejected 957 of 977 planned captures with the
  same paywall-shell signature and was stopped after four usable articles,
  confirming that its larger catalog count does not represent recoverable
  article text. The current-parser 2013 probe reached eight usable articles
  against 1,835 capture-level paywall/source errors and was stopped for the
  same reason; these 2012--2015 cells remain source-limited, not parser
  failures.
  A later current-parser `holdout-v200` audit reconfirmed the same boundary:
  after 312 capture-level failures it had only two usable full-text articles,
  while direct replay of representative HTTP-200 Wayback/Common Crawl records
  produced signed-out 201-character `［有料会員限定］` excerpts. The formal
  scheduler now excludes Nikkei 2012--2015 from the available-full-text year
  set instead of repeatedly treating URL catalog counts as 800-article source
  capacity. Their catalogs remain preserved and can be re-enabled when a new
  independent full-text source supplies an adequate pool.
  The format-4 replay of Lianhe Zaobao 2016 `holdout-v305` later exposed two
  duplicate selected images: legacy Drupal pages emitted the same styled file
  once without a query and once with an `?itok=...` cache token. The parser
  now treats those delivery variants as one asset. All `zaobao-parser/0.1.19`
  convergence evidence is superseded, and each available Zaobao year requires
  a fresh zero-overlap cohort on the bumped parser.
- Lianhe Zaobao's 2017 validation exposed four genuine short news briefs and
  embedded site controls in earlier parser versions. `zaobao-parser/0.1.5`
  addressed those cases, while a current holdout replay then exposed legacy
  Drupal pages whose body is stored under `#article-content` with a visible
  Chinese date. `zaobao-parser/0.1.6` now selects that body, parses the local
  date, and keeps the control cleanup; the affected samples are complete in
  local regression fixtures. The interrupted `holdout-v1` reached 158
  evaluated rows before the fix and is not convergence evidence; a fresh
  zero-overlap `holdout-v2` has now formally converged on
  `zaobao-parser/0.1.6`: 800 QA-passing rows after 804 evaluations, zero
  parser errors, zero prior/exclusion overlap, zero hard content anomalies,
  and 800 audited complete extraction statuses. Its content audit retained
  1,726 selected images and left two non-hard review candidates.
  A 2020 audit then found a legitimate 28-character Reuters wire brief just
  below the old 60-character floor. `zaobao-parser/0.1.7` lowers only the
  ordinary-article floor to 20 characters with a regression fixture. A 2016
  audit then exposed the legacy `#article_content .a_body` body wrapper;
  `zaobao-parser/0.1.8` now selects it. The fresh zero-overlap `holdout-v3`
  2016 audit formally reached 800 audited complete rows with zero hard
  anomalies. The fresh `holdout-v5` audits for 2019--2024 also reached 800
  complete rows with zero hard anomalies; the remaining cells continue
  running or are source-limited.
  The current-parser `holdout-v58` replay for 2025 has now also passed both
  gates at 800/800 complete rows, zero overlap, zero hard anomalies, and eight
  non-hard review candidates.
- SCMP 2017's first validation probe was source-limited: the current Wayback
  URL-key shard initially exposed only 32 candidates, and all captured pages
  identified as 1995 articles rather than 2017 publications. The Common Crawl
  supplement now exposes 5,298 dated 2017 candidates (and over 43,000 across
  2016--2026). The first broad replay found a parser defect in legacy Drupal
  pages: complete prose lived under `.pane-node-body .pane-content` but was
  not selected, leaving only 50--90 character summaries. `scmp-parser/0.1.2`
  fixes that selector. A later audit exposed a legacy SCMP `bookmark-icon.png`
  sharing control being selected as editorial media; `scmp-parser/0.1.3` now
  filters those legacy sharing/print controls at both metadata and body-image
  stages. The 0.1.3 `holdout-v3` reached 800 audited clean rows, but evaluated
  1,042 candidates because 238 were unsupported, leaving aggregate QA at 76.8%
  and the readiness gate closed. Review of those rows found explicit SCMP
  access shells such as `READ FULL ARTICLE` with no recoverable body. The next
  audit also identified image-only `/infographics/` and `-gallery` pages; QA
  revision 2 screens all three source-limited non-article forms while retaining
  their raw captures. A sampled 2016 capture then exposed a second parser
  defect: legacy Vue pages can retain the full article only in
  `window.__APOLLO_STATE__`, while the DOM article node is empty.
  `scmp-parser/0.1.6` now renders that structured body and restores its
  Apollo inline images (with ads and related chrome excluded). A 2021 audit
  then confirmed Apollo-only image slideshow/newsletter packages with
  `displaySlideShow=true` and no prose; QA revision 3 screens those media-only
  packages while retaining their raw captures. Fresh zero-overlap `holdout-v7`
  replays for 2016--2022 are dispatched against the revised policy. The v7
  content audits for 2016--2020 have each reached 800 complete rows with zero
  hard anomalies; 2017 is now included. Earlier v6 evidence remains historical
  for those cells.
  The fresh zero-overlap `holdout-v48` 2017 replay independently confirmed
  `scmp-parser/0.1.6` at 815 evaluated rows (800 audited complete rows), with
  zero parser errors, zero overlap, zero hard content anomalies, and no review
  candidates.
  Expanded Common Crawl coverage now also allows fresh zero-overlap `holdout-v49`
  (2021) and `holdout-v50` (2022) to formally pass on `scmp-parser/0.1.6`:
  each has 800/800 QA-passing complete rows, zero parser errors, zero hard
  anomalies, and zero prior/exclusion overlap. The current-parser `validation`
  baseline for 2023 has now reached 800/800 QA-passing rows with zero hard
  anomalies and two non-hard review candidates. Its fresh zero-overlap
  `holdout-v1` now has 472/800 eligible rows after excluding the 800-row
  baseline, all 472 QA-passing with zero parser errors; it remains
  source-limited while the Common Crawl catalog expands.
  The 2010--2015 source shard currently exposes fewer than 800 dated candidates
  per year; later years remain source-limited pending additional catalog
  coverage. The first fresh 2023 probe (`holdout-v51`) found 1,272 catalog
  candidates, but all were already covered by the baseline and prior-holdout
  exclusion union, leaving zero actionable rows; it is retained as a
  source-capacity diagnostic, not convergence evidence. Common Crawl
  expansion is continuing before the next disjoint 2023 replay.
  A later fresh `0.1.14` replay exposed two additional media-only forms before
  they reached the 800-row gate. A 2016 article titled `Asia gone MAD:
  graphic` contains one linked infographic as its entire editorial body;
  `scmp-parser/0.1.15` now preserves that image and classifies the record as a
  gallery instead of a partial text article. A 2019 `/native/` campaign
  redirects to `multimedia.scmp.com`, but its archived document retains only
  the title/social cover after the interactive payload is lost. QA revision 7
  retains both raw captures while replacing image-only graphics and native
  multimedia shells in the independent text-article cohort. Replaying the two
  real B2 captures locally now yields `nonarticle-desk` with zero evaluated
  article rows; fresh zero-overlap `0.1.15` cohorts supersede the incomplete
  `0.1.14` SCMP runs.
  The first `0.1.15` capture batches then exposed two Young Post templates
  before convergence. A 2016 React/Apollo recipe retained 1,359 characters
  in styled `div.p` nodes, but generic block extraction emitted only a nested
  54-character link; a 2020 English exercise stored its editorial worksheet
  in an 838x1024 body image with only a 22-character answer link. Current
  `scmp-parser/0.1.16` extracts styled fallback paragraphs carrying the newer
  literal `p` class and treats a
  short image-bearing `/english-exercises/` record as a gallery. Replaying
  the exact B2 HTML now yields a 15-block complete article for 2016 and a
  complete image-led gallery for 2020. A wider replay then found older Young
  Post pages using the same styled fallback component without the `p` class;
  `scmp-parser/0.1.17` matches the stable component name and restores those
  paragraphs as standard blocks and plain text. QA revision 8 also retains
  corporate announcement pages and explicit empty archived body shells as raw
  evidence while excluding them from the recoverable text-article denominator.
  Fresh zero-overlap `0.1.17`/QA-8 cohorts then exposed a 2018 audio player
  nested inside a paragraph:
  the raw MP3 source survived, but ancestor de-duplication omitted its embed
  block. `scmp-parser/0.1.18` preserves nested audio as a first-class embed;
  fresh zero-overlap `0.1.18`/QA-8 cohorts therefore supersede `0.1.17`.
  The subsequent 2012 content audit found two legacy mobile pages serving the
  same bookmark control from `m.scmp.com`, outside the existing CDN and
  desktop-host filter. `scmp-parser/0.1.19` rejects that mobile-host variant;
  fresh zero-overlap `0.1.19`/QA-8 cohorts supersede `0.1.18`.
- An early 2020 `0.1.19` replay then exposed two independent archive shapes:
  SCMP Cooking pages whose full text and article-owned image references exist
  only under a direct Apollo `body` field, and `SCMP Series` collection pages
  that redirect away from an apparent article URL. `scmp-parser/0.1.20`
  recovers and deduplicates the direct body plus its resolved editorial images;
  QA-9 screens the explicit collection package from the article denominator.
  Fresh zero-overlap `0.1.20`/QA-9 cohorts supersede `0.1.19`.
- At sample 612, the 2016 QA-9 replay found a racing infographic on a normal
  `/sport/racing/article/` route. Its complete recoverable payload is one
  editorial image plus the 59-character handoff `Click to view the full-size
  infographic in high resolution.`; it is a media package rather than a
  failed text extraction. `scmp-parser/0.1.21`/QA-10 screens that exact
  infographic handoff, and fresh zero-overlap cohorts supersede `0.1.20`.
- The 2021 SCMP replay also exposed a Common Crawl record capped at exactly
  1 MiB whose WARC header declared `WARC-Truncated: length`; it ended midway
  through Apollo JSON and therefore could never contain the article body.
  Common Crawl acquisition now rejects any origin-truncated WARC response so
  capture selection can continue to another snapshot instead of storing the
  fragment as a valid HTML object.
- Current `scmp-parser/0.1.45` has formally converged for 2014
  (`holdout-v223`) and 2015 (`holdout-v221`). Each formal content gate audited
  800/800 complete rows with zero parser errors, zero prior/exclusion overlap,
  and zero hard anomalies. The two unsupported 2014 reserve captures and one
  partial 2015 reserve capture were outside the independently selected
  800-row content samples. Manual review confirmed the 2014 repeated strings
  are a newsroom email and AFP reporting credit; the four small 2015 images
  are genuine 2--4.5-star review-rating graphics rather than site chrome.
- A later strict recheck of SCMP 2021 and 2023 found that their only
  non-complete formal rows were genuine `VideoObject` packages. It also
  exposed a hidden date defect: the parser ignored the structured video
  publication timestamp and fell back to the catalog date, allowing a 2018
  video soft-redirect to occupy a 2021 slot. `scmp-parser/0.1.46` now reads
  `datePublished` (falling back to `uploadDate`/`dateCreated`) plus
  `dateModified` from SCMP video JSON-LD. The content audit accepts an
  unsupported non-text package only when its type and publication year are
  validated, and emits every such package for manual review; partial/error
  rows remain forbidden. All `.45` SCMP evidence is therefore superseded and
  fresh zero-overlap `.46` cohorts are required for every available year.
- Manual review of the otherwise clean 2020 `.46` sample found a flattened
  `Purchase the 120+ page China Internet Report` promotion and two Methode
  filename variants of the same photographs emitted as separate images.
  `scmp-parser/0.1.47` removes the exact report campaign when its purchase and
  offer signals are present, and merges `_image_hires_`/size-token renditions
  that share the same Methode UUID and article suffix. Content-audit format 4
  now rejects duplicate selected-image identities. All SCMP `.46` evidence is
  superseded; `.47` requires fresh zero-overlap samples for every year.
- SCMP 2020 `.47` replay then exposed three non-news utility/media packages:
  two Young Post answer keys under legacy `/yp/article` and `/yp/discover/news`
  routes, plus a short Presented page redirected to an unrecoverable branded
  infographic. QA policy 19 screens those exact package families from the
  text-article denominator while retaining their raw captures. This is a QA
  eligibility correction, not a body-parser change, so `.47` cohorts replay
  under QA-19 without treating the same captures as successful articles.
- Independent `.47` samples then exposed two preserved Young Post visual
  formats that were incorrectly reported as partial text: a 28,201-pixel-tall
  infographic nested inside a paragraph, and a twelve-image quote sequence
  with no prose. `scmp-parser/0.1.48` retains the nested publisher-marked body
  image and treats a substantial Young Post body-image sequence as a gallery.
  Both exact raw captures now parse as complete non-text content; every SCMP
  year therefore requires a fresh zero-overlap `.48` cohort.
- FT's date-less `/content/<uuid>` Wayback catalog can assign a later capture
  year to an older article. For UUIDv1 content identifiers, validation now
  decodes the standardized UUID creation timestamp before sampling; opaque
  UUIDv4 identifiers remain unresolved. In the live 2018 cohort this rejects
  seven proven 2006--2015 URLs before another network request and keeps the
  same-year replacement pool available to the current FT parser cohort.
- Manual review of FT 2019 then found complete articles actually published in
  2010, 2011, 2014 and 2015 inside the nominal 2019 cohort. The parser had
  recovered the correct timestamps, but content-audit format 4 only enforced
  publication-year equality for unsupported non-text packages. Format 5 now
  makes a missing or mismatched parsed publication year a hard anomaly for
  every complete extraction as well. FT QA policy 7 also rejects such rows
  during validation so same-year replacements can enter the cohort. All
  format-4 audit evidence must be regenerated before any affected cell can
  count as formally ready.
- The first format-5 replay of AP 2023 exposed a year-boundary case rather
  than a bad article: AP's canonical timestamp was
  `2024-01-01T02:25:16Z`, while the archive catalog retained the same
  publication in the publisher-facing `-05:00` timezone on December 31,
  2023. Comparing the raw UTC year incorrectly rejected it. Content-audit
  format 6 and AP QA policy 1 now convert the parsed instant to the capture
  record's timezone before comparing publication years. Genuine mismatches
  such as an FT 2011 article assigned to a 2019 capture cohort remain hard
  failures. All format-5 content audits must be regenerated.
- NYT's first format-5 2012/2014 audits then exposed two legacy-template
  defects. Three 2012 articles emitted one `static01.nyt.com` photograph both
  as a canonical URL and with old `year/h/w/s/k` rendition parameters, while
  a 2014 runway interactive stored 52 substantive narrative paragraphs inside
  multi-paragraph `figcaption` elements. `nyt-parser/0.8.153` merges those
  signed renditions and preserves paragraph-level prose in selected NYT
  interactive figures. Exact replay of all four source captures is complete:
  the three duplicate-image cases now have zero duplicate selected assets and
  the interactive grows from 187 to 6,483 extracted characters.
- NYT 2017 `holdout-v338` produced 800 QA-passing articles plus one rejected
  boundary candidate. Its `/2017/12/31/` URL and catalog date disagree with
  NYT's authoritative `2018-01-01T00:10:52Z` publication timestamp, so the
  validator correctly labels that row `publication-year-mismatch` and samples
  a replacement. Validation summaries and the action-state gate now screen
  that rejected row from the article denominator, just as their existing
  comments require. Exact checkpoint replay changes the result from 800/801
  (99.88%) to 800/800 (100%) without changing any accepted article, parser
  output, parser version, QA revision, or zero-overlap evidence.
- Manual review of NYT 2022 `holdout-v222` found a standardized subscriber
  recommendation/signup paragraph preserved after the Climate Forward
  editorial sign-off. `nyt-parser/0.8.154` removes only that exact newsletter
  CTA while retaining the surrounding credits, past-editions link and contact
  email. The exact raw capture now remains complete with 45 blocks instead of
  46, so every NYT year requires a fresh zero-overlap `.154` cohort.
- SCMP 2021 `holdout-v250` then exposed a valid redirected multimedia package
  that the text parser had treated as an empty regular article. The selected
  Wayback representation is SCMP's complete China Internet Report 2021 landing
  page on `multimedia.scmp.com`, with a substantial two-section report shell,
  publisher artwork and download interaction. `scmp-parser/0.1.49` recognizes
  that narrow static-report template and preserves the publisher document as
  an interactive embed. Exact raw replay changes the result from unsupported
  with zero blocks to complete interactive content with one embed and one
  selected image. All `.48` SCMP evidence is superseded and must rotate to
  fresh zero-overlap `.49` cohorts.
- Manual review of SCMP 2012 `holdout-v236` found 137 cross-article selected
  image identities from 2021--2022 inside otherwise unrelated 2012 stories.
  Modern normalized Apollo caches store topic and reverse-section artwork
  beside the URL-bound current article body; the legacy image fallback had
  appended that unscoped shell artwork as body media. `scmp-parser/0.1.50`
  suppresses unscoped cache images whenever a canonical URL-matched body is
  present, while retaining explicitly article-scoped and inline body images.
  Exact replay of four representative raw captures remains complete and drops
  all 16 false image blocks, so every SCMP year requires a fresh zero-overlap
  `.50` cohort.
- NPR 2016's first complete 800-row audit retained a repeated Tiny Desk
  subscription sentence in ten concert pages. `npr-parser/0.1.58` removes the
  exact podcast CTA while preserving set lists, credits, transcript speaker
  labels and the separate First Listen availability note as editorial text.
- The same FT 2012/2017/2019 manual review found punctuation-only visual rules
  (a legacy ellipsis line and a seven-character mixed dash line) surviving as
  body paragraphs, plus UPP asset
  `0db36b94-146a-11e7-80f4-13e067d5072c` reused as the lead image across
  unrelated media, cosmetics, retail, tobacco and finance stories.
  `ft-parser/0.8.67` removes only sufficiently long punctuation-only rules and
  rejects that exact fallback asset. Exact replay of all 15 affected archived
  captures retained complete extraction status with zero separator or
  fallback-image residue. Every prior FT cohort is superseded and must rotate
  to a fresh zero-overlap `.67` sample.
- FT 2018 `holdout-v226` reached 800/800 but content-audit format 6 found two
  duplicate-selected-image failures. One Arquivo capture wrapped an FT
  Origami URL around another Origami URL and added an optional overlay; an
  Irish Times syndication page exposed one photograph as four signed aspect
  crops. `ft-parser/0.8.68` unwraps archive image replay locations before
  recursive Origami identity normalization and treats the stable Irish Times
  resizer path as one asset. Exact raw replay preserves complete text and
  changes the two records from four images to one, and from four to two (one
  lead plus one distinct body graphic). All `.67` FT evidence is superseded
  and requires fresh zero-overlap `.68` cohorts.
- FT's completed 2022 `0.8.56` cohort exposed twelve podcast subscription
  controls flattened into otherwise valid episode transcripts. The controls
  advertise FT News Briefing or the FT Weekend Podcast on external podcast
  services and are not episode content. `ft-parser/0.8.57` removes those exact
  standalone calls-to-action while preserving the transcript and audio; fresh
  zero-overlap `0.8.57` cohorts supersede `0.8.56`. The 2016 audit also found
  one AMP capture whose source HTML had deterministically corrupted both smart
  quotes around an artwork title. `ft-parser/0.8.58` repairs only those exact
  damaged sequences; its fresh cohorts supersede `0.8.57` before that
  intermediate version accrued validation state. Early `0.8.58` replay then
  showed that FT frequently retains the generic document title `Subscribe to
  read | Financial Times` even when the archived page state contains a fully
  recoverable article and real headline. The QA screen had consequently
  excluded 163 complete 2022 articles (median body length 4,211 characters).
  `ft-parser/0.8.59`/QA-5 now screens that title only when the extracted
  headline is itself a subscription shell; a real 2022 archive sample with
  11,750 body characters replays as an evaluated QA pass. Fresh zero-overlap
  `0.8.59` cohorts supersede `0.8.58`.
- Nikkei's first 2017 validation reached 800 QA rows but its content audit
  found three embedded `form`/`input`/`button` controls. The parser now removes
  those site-wide controls as `nikkei-parser/0.1.7`; the fresh zero-overlap
  `holdout-v1` has formally converged at 800/800 with QA 100%, zero parser
  errors, zero prior or exclusion overlap, zero hard content anomalies, all
  extraction statuses complete, and 761 selected images (15 non-hard review
  candidates). A fresh zero-overlap `holdout-v1` for 2016 has now also
  formally converged on the same parser: 800/800 QA-passing rows, zero parser
  errors, zero prior/exclusion overlap, zero hard content anomalies, all
  extraction statuses complete, and 592 selected images (16 non-hard review
  candidates). The supplement currently exposes about 6,013 dated 2017
  articles and 1,789 for 2016. The new `holdout-v3` schedule supersedes the
  incomplete 2012--2015 and 2018--2026 probes once its current-version audits
  finish. The 2018 and 2019 v3 rotations have now formally passed on
  `nikkei-parser/0.1.7`, each with 800/800 QA-passing complete rows, zero
  parser errors, zero hard anomalies, and zero prior/exclusion overlap;
  2012--2015 are continuing against their expanded Common Crawl pools.
- Reuters 2020 historically converged on `reuters-parser/0.7.25` with a
  fresh zero-overlap `holdout-v42`: 800/800 QA-passing and complete rows, zero
  parser errors, zero prior/exclusion overlap, zero hard content anomalies,
  and two non-hard review candidates. Separate zero-overlap `holdout-v49` (2016)
  and `holdout-v50` (2019) also passed the same gates on `.25` at 800/800, with
  one and two non-hard review candidates respectively. Other Reuters years are
  being scheduled against their separate historical source windows. Current
  `reuters-parser/0.7.27` removes a new social-channel CTA and statbox input
  control found in the 2022
  audit; fresh zero-overlap replays for the previously passing years are now
  running against `.26`. The 2022
  `holdout-v54` audit exposed a social-channel CTA (`YouTube`, Telegram, and
  WhatsApp); the fresh `holdout-v59` 2022 replay then exposed the input control,
  so `.27` requires another fresh zero-overlap 2022 replay.
  That `.27` replay (`holdout-v68`) now passes 800/800 with zero parser errors,
  zero overlap, zero hard anomalies, and three non-hard review candidates;
  `.27` replays for 2016 (`holdout-v69`), 2019 (`holdout-v70`), and 2020
  (`holdout-v71`) also pass 800/800 with zero hard anomalies.
- Zaobao 2016 format-6 review found a Drupal-era source paragraph whose long
  terminal clause was appended twice inside the archived HTML. The ordinary
  duplicate-block metric could not see repetition within one paragraph.
  `zaobao-parser/0.1.21` now removes only an exact, long, punctuated tandem
  suffix from text-only paragraphs; QA-6 rejects any surviving instance.
  Every earlier Zaobao cohort is superseded and must rotate to a fresh,
  zero-overlap `.21` sample.
- The completed `.21` `holdout-v307` content audit then exposed a legacy
  `/forum/comic/` page whose editorial cartoon survived only in source-only
  `<picture data-srcset>` renditions. The parser selected its social-card
  image but emitted no matching image block, while two non-archivable
  Newspost/Newsmine service icons occupied the body positions. Exact replay
  on `zaobao-parser/0.1.22` materializes the largest publisher rendition,
  merges it with the structured lead as one asset at the correct body
  position, and removes both service icons. All `.21` evidence is superseded;
  every available Zaobao year requires a fresh zero-overlap `.22` cohort.
- TODO: migrate the runner, workflows, secrets documentation, and open
  validation history to the public
  [`kargonerd/jojokanbao`](https://github.com/kargonerd/jojokanbao) repository.
  Do not switch repositories while Actions batches are still using validation
  checkpoints in this repository.

## License and content notice

The software in this repository is licensed under the MIT License. Third-party
news content is not distributed by this repository and remains subject to the
rights and terms of its original publishers and archive providers. Users are
responsible for ensuring that their use is authorized and lawful.
