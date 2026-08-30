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

The imported `jojo-article/1` model remains an internal parser result. A
Canonical bridge will rebuild semantic HTML from ordered blocks, materialize
selected images by byte hash, and call the Times Canonical writer. Renaming or
directly publishing `jojo-article/1` is not valid.

Historical Japanese `www.nikkei.com` content maps to a distinct
`nikkei-japan` source. Only English `asia.nikkei.com` content maps to the
existing Times `nikkei` source.

## Layout

```text
jojo_olds_api/       Historical capture and parser library
tools/               Python command-line entry points
tests/               Parser, capture, validation, and workflow-contract tests
schemas/             Internal RawCapture and parser-result JSON Schemas
workflow-templates/  Inactive legacy workflows awaiting HF conversion
```

The previous B2 layout is documented only to support a verified one-time
migration in [LEGACY_B2_LAYOUT.md](LEGACY_B2_LAYOUT.md). Parser convergence
history is retained in [VALIDATION_STATUS.md](VALIDATION_STATUS.md).

## Test

```bash
python -m pip install -r tools/news-archive/requirements.txt "pytest>=8,<10"
python -m pytest -q tools/news-archive/tests
python tools/news-archive/tools/export_news_schemas.py --output-dir /tmp/news-schemas
diff -ru tools/news-archive/schemas /tmp/news-schemas
```
