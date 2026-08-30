# Historical news archive

This directory contains JOJO's historical news discovery, capture, parser, and
parser-validation tooling. It is intentionally a Python tool rather than a
backend service or pnpm workspace.

The code is being migrated from the temporary public
`jojo-news-archive-runner` repository. The workflow files below
`workflow-templates/` are inert migration inputs: GitHub does not execute
workflows outside the repository-level `.github/workflows` directory. They
must not be copied into the active workflow directory until their storage
steps use Hugging Face and the controlled cutover has passed.

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
jojo_news_archive/  Historical capture and parser library
tools/              Python command-line entry points
tests/              Parser, capture, validation, and workflow-contract tests
schemas/            Internal RawCapture and parser-result JSON Schemas
workflow-templates/ Inactive legacy workflows awaiting HF conversion
```

The one-time B2-to-HF state mapping and cutover gates are documented in
[MIGRATION.md](MIGRATION.md). Generated validation reports and historical run
logs belong in HF Raw, not in this source tree.

## Test

```bash
python -m pip install -r tools/news-archive/requirements.txt "pytest>=8,<10"
python -m pytest -q tools/news-archive/tests
python tools/news-archive/tools/export_news_schemas.py --output-dir /tmp/news-schemas
diff -ru tools/news-archive/schemas /tmp/news-schemas
```

## HF migration batches

Downloaded legacy B2 prefixes are inventoried into four exact file sets. The
order is immutable Raw, catalog, checkpoint, then completion marker:

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

## Canonical bridge

`tools/export_canonical_batch.py` replays verified Raw capture records through
the historical parser and emits only QA-passing `jojo-news-canonical-input/1`
rows. `@jojo/times-pipeline archive-canonical --action prepare` then builds
semantic HTML and an exact HF file-set for selected image bytes. Upload that
Raw image file-set first. Finally, `--action write` pins the resulting HF Raw
revision, restores affected existing date indexes, and writes the shared
`jojo-news-article/2` Canonical objects and their exact upload file-set.

The bridge never requests images classified by the parser as advertisements,
logos, avatars, recommendations, icons, or tracking assets. A failed editorial
image is omitted without discarding the article text.
