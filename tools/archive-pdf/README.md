# Archive PDF tooling

Repository-level tools for preparing, publishing, and verifying protected Archive
PDF files. They operate across the content pipeline, object storage, EdgeOne,
and the Archive Web module, so they are not owned by a single app or service.

Use the stable root commands rather than invoking files by path:

```bash
pnpm protect:archive-pdf
pnpm verify:archive-pdf
pnpm publish:archive-pdf
pnpm purge:archive-pdf
pnpm finalize:archive-pdf
pnpm sync:rmrb
```

## Files

- `protect.mjs` encodes or decodes the position-dependent byte mask.
- `verify.mjs` checks local files or public URLs, including HTTP Range support.
- `publish.mjs` linearizes, protects, verifies, and uploads selected issues.
- `purge-cache.mjs` submits EdgeOne URL or prefix purge tasks.
- `finalize.mjs` purges public URLs and polls verification until the protected
  objects are visible.
- `sync_rmrb.py` publishes RMRB PDFs to Hugging Face Canonical, then uploads
  immutable Jox media, the issue manifest, and the dataset index to B2 Delivery.
- `delivery.py` stages and publishes the exact Canonical/Delivery patch while
  preserving article content, operator edits, metadata, and calendar gaps.
- `verify_delivery.py` verifies the published manifest and Jox PDF byte ranges
  through the public CDN.

`sync_rmrb.py` requires `pip install -r tools/archive-pdf/requirements.txt`, plus
the `qpdf`, `node`, and `rclone` executables. It reuses `RMRB_REVIEW_HF_REPO`
(then `HF_DATASET_REPO`, default `luoxiaozhuang/marxism-dataset`), `HF_TOKEN`
or the HF CLI login, and `JOJO_DELIVERY_REMOTE` (then `B2_REMOTE:B2_BUCKET`).

## Archive Delivery cutover

All five Archive readers resolve `catalog.jox` → Dataset index → issue manifest
→ the primary `issue-pdf` asset. Newspaper paths come from `itemPath`; magazine
paths come from `items[].manifestObject`. PDF bytes use the existing Jox object
key and range offset for decoding, including browser downloads. No reader
falls back to the old uppercase directories.

The initial RMRB Delivery calendar ends on **2026-07-18**. Before deploying the
reader change, backfill subsequent dates and verify the CDN. The daily workflow
now uses `--catch-up --reuse-legacy`, resumes after the last committed Delivery
date, and verifies the results. It updates each date separately so a failed run
can continue on retry. `--reuse-legacy` only reads old PDFs as migration input;
it never uploads to the old directory.

```powershell
# Stage one date locally; neither HF nor B2 is modified.
pnpm sync:rmrb --date 20260719 --reuse-legacy --dry-run

# Backfill through the target date, or run the updated daily workflow.
pnpm sync:rmrb --start-date 20260719 --date 20260910 --reuse-legacy

# Purge the metadata URLs listed in .rmrb-sync-work/publication.json, then:
python tools/archive-pdf/verify_delivery.py .rmrb-sync-work/publication.json
```

`--force` fetches the source again and writes a new hash-named Jox PDF. Metadata
uses revalidation cache headers; existing PDFs are never overwritten or deleted.
HF commits require the parent revision; changed B2 metadata stops publication
for a fresh retry. Source PDFs and staged files remain under `.rmrb-sync-work/`
for inspection. `--dry-run` stages each date against the current remote snapshot;
it is not a combined multi-date transaction.

The older `publish.mjs` and masking/cache tools above remain legacy maintenance
tools, not the Jox publisher. Removing old B2 directories is a separate cleanup
after new readers are deployed, data coverage is verified, and old clients are
retired.

Validation:

```powershell
python -m unittest discover -s tools/archive-pdf/tests -v
python -m unittest discover -s tools/jojo-admin/server/tests -p test_rmrb_review_publish.py -v
```
