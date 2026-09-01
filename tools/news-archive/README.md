# Historical news archive

This directory contains JOJO's historical news discovery, capture, parser, and
parser-validation tooling. It is intentionally a Python tool rather than a
backend service or pnpm workspace.

The code is being migrated from the temporary public
`jojo-news-archive-runner` repository. Its legacy B2 writer workflows are
disabled and are intentionally not duplicated here. New workflows in this
repository must be designed around Hugging Face rather than ported from the
legacy storage implementation.

## Storage boundary

Historical news follows the same three-layer contract as JOJO Times:

1. **HF Raw** stores original HTML, capture records, manifests, assets, and
   resumable validation state below `raw/archive/`.
2. **HF Canonical** stores full articles using the existing
   `jojo-news-article/2`, `jojo-news-date/1`, and `jojo-news-dataset/2`
   contracts below `canonical/`.
3. **B2 Delivery** is produced only by the Times delivery stage after a
   Canonical article is ready. Historical capture and parser validation must
   not write Raw, Canonical, or checkpoints to B2.

The imported `jojo-article/1` model remains an internal parser result. The
Canonical bridge rebuilds semantic HTML from ordered blocks, materializes only
parser-approved editorial images by byte hash, and calls the Times Canonical
writer. Renaming or directly publishing `jojo-article/1` is not valid.

Historical Japanese `www.nikkei.com` content maps to a distinct
`nikkei-japan` source. Only English `asia.nikkei.com` content maps to the
existing Times `nikkei` source.

## Layout

```text
jojo_news_archive/
  models.py         Shared immutable Raw/parser models
  sources/
    registry.py     Single SourceModule registry
    contracts.py    Source contracts shared by every publisher
    bloomberg/      Bloomberg spec, discovery, parser, capture, validation
    wsj/            WSJ spec, discovery, parser, capture, validation
    ...             One vertical package for each publisher
  capture/          Publisher-neutral capture/checkpoint engine
  discovery/        Publisher-neutral archive provider primitives
  parsing/          Publisher-neutral parser/QA orchestration
  orchestration/    Bounded planners and watchdog logic
  migration/        One-time legacy B2-to-HF mapping and verification only
tools/              Thin Python command-line entry points
tests/              Parser, capture, validation, and architecture tests
schemas/            Internal RawCapture and parser-result JSON Schemas
```

Each publisher owns its URL rules, parser specification, discovery adapters,
capture policy, parser implementation, and validation policy below
`sources/<publisher>/`. Shared engines load those implementations through the
source registry/runtime boundary; they must not import individual publisher
packages directly. Architecture tests enforce this vertical layout and reject
media-named implementations outside `sources/`.

Library modules use explicit absolute imports. The root package is intentionally
limited to `models.py`; architecture tests reject new flat compatibility
modules. Caixin is removed from the archive package and registry. Its legacy
B2/HF namespaces are explicitly rejected by the one-time migration code, so
old research objects cannot be replayed, copied, or accidentally reactivated.
`B2_ARCHIVE_*` credentials are forbidden from the runtime library and future
new-repository runners. Only the quarantined one-time `migration/` code
understands approved legacy B2 object names.

## Version and retention policy

Raw HTML and approved resources are immutable and content-addressed. Uploading
identical bytes is a no-op; attempting to reuse an object name for different
bytes fails. Parser development outputs, temporary SQLite databases, proxy
state, and per-attempt HTML stay local and are deleted after their bounded run.
They are never published as version-named copies such as `v203` or `v340`.

HF keeps only three durable result classes: shared immutable Raw, the one
currently active resumable checkpoint for an unfinished cell, and the final
passing 800-article cohort. A failed formal cohort contributes a small audit
summary and its failing examples to the regression corpus; it does not retain
a second full copy of Raw or a complete result database. Checkpoints are
published in bounded deltas and compacted at cell completion instead of
rewriting one large gzip or SQLite object after every article.

The mutable operational checkpoint must remain separate from immutable Raw and
final Canonical history. Once a cell passes, its compact final audit is copied
to the durable dataset and the operational state history is squashed. B2 Raw
has no continuing writer after cutover, and B2 Delivery uses immutable content
keys plus a last-version-only lifecycle for the few mutable indexes.

The one-time B2-to-HF state mapping and cutover gates are documented in
[MIGRATION.md](MIGRATION.md). Generated validation reports and historical run
logs belong in HF Raw, not in this source tree.

## Test

```bash
cd tools/news-archive
python -m pip install -r requirements.txt "pytest>=8,<10"
python -m pytest -q
python tools/export_news_schemas.py --output-dir /tmp/news-schemas
diff -ru schemas /tmp/news-schemas
cd ../..
```

## HF migration batches

`B2_ARCHIVE_*` is a local, one-time read-only migration credential. It is not
used by a persistent Actions runner. The B2 application key itself must be
restricted server-side to the archive bucket/prefix with list/read permissions
only. Plan a bounded batch before copying it:

```bash
python tools/news-archive/tools/stage_legacy_b2_batch.py \
  --legacy-b2-prefix news-archive/v1/bloomberg/2020-2020/legacy-wayback \
  --output-dir .archive-work/bloomberg-2020 \
  --manifest-dir .archive-work/bloomberg-2020-manifests \
  --max-files 2500 --max-bytes 250000000
```

Add `--execute` only after reviewing the exact object/byte count. The staging
command never writes to or deletes from B2. It downloads one complete
publisher/window/mode or cohort/publisher/year batch, then performs the same
deep verification described below. A v2 batch with SQLite references into an
already migrated v1 corpus supplies its verified v1 file sets with repeated
`--available-file-manifest` arguments.

Downloaded legacy B2 prefixes are inventoried into four exact file sets. The
order is immutable Raw, catalog, checkpoint (including small migration audit
receipts), then a non-empty completion-summary phase:

```bash
python tools/news-archive/tools/prepare_hf_archive_batch.py \
  --root .archive-work/migration-batch \
  --output-dir .archive-work/file-sets
python tools/news-archive/tools/verify_hf_archive_batch.py \
  --root .archive-work/migration-batch \
  --manifest-dir .archive-work/file-sets
```

The TypeScript HF client uploads only the files named by one file set; it does
not scan or re-upload the whole output tree. Later validation-state batches may
pass previously verified v1 file sets with repeated
`--available-file-manifest` arguments so references can be checked without
downloading the same Raw corpus again.

After those four uploads, `tools/write_hf_archive_run_manifest.py` records each
phase revision and packages the run manifest together with copies of all four
exact file sets below `raw/archive/runs/`. Upload that five-file run bundle and
use its resulting HF revision as the parser-replay revision. Canonical input is
rejected if the run object, phase file sets, hashes, or selected Raw prefix do
not match. `migrationComplete: true` means the exact B2 snapshot was copied and
verified; it does not claim that the source crawl or parser-validation target
inside that snapshot had already converged.

Every `hf --action upload-files` call requires the exact current
`--expected-parent-revision`, one exact batch `--allowed-prefix`, and an explicit
`--existing-policy`. Immutable Raw, run-bundle, and archive-asset objects cannot
use `replace`: an identical existing object is skipped and different bytes fail.
The four phase revisions and the fifth run-bundle revision are distinct; the
latter is passed to Canonical prepare as `--replay-revision` and must match every
input row.

`tools/prepare_hf_archive_replay.py` rewrites an immutable file set so both its
local and remote paths use final HF object names. This exact manifest is used
to download a parser-replay workspace. For a local canary, `--materialize`
creates hard links where possible and does not duplicate Raw bytes.

## Canonical bridge

`tools/export_canonical_batch.py` replays verified Raw capture records through
the historical parser and emits only QA-passing `jojo-news-canonical-input/1`
rows. Its optional `--report` records input, accepted, duplicate, rejected, and
per-reason counts. `@jojo/times-pipeline archive-canonical --action prepare`
requires the pinned fifth-commit `--replay-revision`, then builds semantic HTML
and an exact HF file-set for selected image bytes. Upload that
Raw image file-set first. Finally, `--action write` pins the resulting HF Raw
revision, restores affected existing date indexes, and writes the shared
`jojo-news-article/2` Canonical objects and their exact upload file-set.
Publish that file-set with `hf --action upload-archive-canonical`, using the
report's `rawRevision` as `--expected-parent-revision`. This dedicated action
accepts only the exact sources, articles, dates, dataset descriptors, and
deterministic run report named by the report. It replaces date indexes and
dataset descriptors in one parent-locked commit, while an existing article or
run report with different bytes fails closed. Article `contentHash` is not a
whole-file checksum, so overlaps are never overwritten automatically.

The bridge never requests images classified by the parser as advertisements,
logos, avatars, recommendations, icons, or tracking assets. A failed editorial
image is omitted without discarding the article text.
