# RMRB missing-content repair tools

These commands reconcile the canonical PeopleData directory with the existing
JSONL corpus and annual XLSX exports. PeopleData supplies the authoritative
date, edition, ordinal, title and article URL; local sources only supply body
text. Every command writes staging artifacts below `tmp/`. None updates the
source corpus or Elasticsearch.

## Build the canonical merge

Install the small Python tool dependencies:

```powershell
python -m pip install -r tools/rmrb-repair/requirements.txt
```

Fetch or provide the PeopleData daily directory, then build its SQLite index:

```powershell
$env:JOJO_PEOPLEDATA_COOKIE = "<authenticated WebVPN Cookie header>"
python tools/rmrb-repair/fetch_rmrb_peopledata_full_directory.py
python tools/rmrb-repair/build_rmrb_peopledata_directory_index.py
```

Merge the original JSONL and annual XLSX files against that authoritative
directory:

```powershell
python tools/rmrb-repair/merge_rmrb_peopledata_xlsx.py `
  --directory tmp/rmrb-peopledata-full-directory/directory-index.sqlite3 `
  --jsonl D:/path/to/output.jsonl `
  --xlsx-root C:/path/to/annual-xlsx `
  --output tmp/rmrb-peopledata-full-directory/merged-peopledata-canonical.jsonl `
  --unmatched tmp/rmrb-peopledata-full-directory/merged-unmatched.jsonl `
  --report tmp/rmrb-peopledata-full-directory/merged-report.json

python tools/rmrb-repair/build_rmrb_missing_workbench_db.py
```

## Auto-complete image-only records

The search-results endpoint identifies image-only articles without opening the
CAPTCHA-prone detail endpoint. A record is accepted only when its summary is
empty and it contains exactly one article image. The original image is saved
under `tmp/pdfs/rmrb-peopledata-online-images` and the staging decision contains
`【图片】`.

```powershell
powershell -ExecutionPolicy Bypass -File tools/rmrb-repair/start_rmrb_peopledata_image_backfill.ps1
```

The Cookie is inherited by the child process and is never written to a file or
log. Authentication failure, CAPTCHA markup and HTTP 418 stop the collector;
the SQLite checkpoint allows a later run to continue safely.

## Human review

Start the JOJO admin API and web UI, then open `/rmrb-review`. The queue is
strictly date ordered, hides every key already present in any
`manual-review-decisions-*.jsonl`, and writes interactive decisions to
`manual-review-decisions-workbench.jsonl`.

Set these optional environment variables when local paths differ:

```powershell
$env:RMRB_REVIEW_ROOT = "C:/path/to/tmp/rmrb-peopledata-full-directory"
$env:RMRB_SOURCE_PDF_ROOT = "D:/path/to/source-pdfs"
```

## Prepare a publication snapshot

Convert the PeopleData-aligned merge plus every staged decision into one
`jojo-item/1` newspaper Item per day. This command does not upload anything.
Existing archive PDFs are read from `--pdf-root`, validated by presence, and
copied by full SHA-256 into Canonical and Hugging Face `assets/`. Delivery PDF
exports are emitted as range-safe Jox objects. Text and PDF availability are
encoded independently with adaptive calendars.

```powershell
python tools/rmrb-repair/prepare_rmrb_publication.py `
  --output tmp/rmrb-publication/2026-08-18 `
  --snapshot-id 2026-08-18 `
  --pdf-root D:/path/to/source-pdfs
```

The output contains B2 Canonical objects under `canonical/`, public Jox
objects under `delivery/`, a private Hugging Face mirror under
`huggingface/rmrb/`, and private repair audit material under
`raw/newspapers/rmrb/repair-runs/`. Missing articles remain in Items with
`contentState: "missing"`; Delivery keeps their descriptors with
`object: null`. `manifest.json` records every file's size and SHA-256;
`_SUCCESS.json` is written last. Upload remains a separate, explicit operation
after reviewing this dry run.
