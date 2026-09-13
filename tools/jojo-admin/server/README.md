# JOJO 管理台

JOJO Pipe is the local PDF intake tool for reader publications. It renames PDFs,
splits page PDFs, and commits the generated files to a configurable storage
backend.

## React 管理界面

The complete internal application lives in `tools/jojo-admin`: `web/`
contains the React 19 client, while `server/` contains the Flask APIs, PDF
pipeline, and ES migrations. Flask serves the production web build and no
longer renders Jinja pages.

For normal local use, run `start.bat`. It builds the frontend, starts Flask,
then opens the admin console at `http://127.0.0.1:5000/`.

During frontend development, start Flask and Vite together:

```bash
pnpm dev:admin
```

The Vite development UI is at `http://127.0.0.1:4174/` and proxies `/api` to
Flask on port 5000. The lower-level `dev:admin-api` and
`dev:admin-web` commands remain available when only one side needs
debugging.

## Book imports

The `/content` page accepts one EPUB, WeRead WRX JSON, or DRM-free MOBI 6/7 file at
a time through `POST /api/content/import-files`, after the user selects a file and a library source and
clicks “开始处理”. It has no directory picker or path input. The
`POST /api/content/import-paths` endpoint remains available for scripted imports. Both routes
invoke `@jojo/content-pipeline` with strict import defaults and expose job progress
and diagnostics. Browser uploads retain their original sanitized filenames, including
Chinese names, in separate directories so duplicate names cannot overwrite each other.
The local reader at `/content/:jobId/preview` opens generated chapters, images, TOC
links, and notes before publication, including draft and authenticated books.
`GET /api/content/jobs/<job_id>/preview/delivery/<object_key>` serves only `.jox`
files inside that completed job's Delivery directory with `no-store` caching.
It uses the same Jox decoder and body renderer as the public Reader, without
accessing HF/B2 or changing publication state. Source files and paths outside the
job's Delivery directory are not exposed by the preview endpoint.
The browser follows four steps: file selection, processing/preview, publication settings,
and upload results. New browser imports start as local drafts. The publication request
`POST /api/content/jobs/<job_id>/publish` accepts `targets`, `publicationStatus`
(`draft` or `published`) and `access` (`public` or `authenticated`). Omitting the latter
two retains the job's saved settings for existing scripted clients.
For a single-book job, the same request accepts an optional `title` correction.
It preserves Dataset/Item IDs and reading links while updating the catalog,
canonical data, search labels, and the generated EPUB's package title and download
name. Source chapter files and media are preserved. Both previously uploaded targets
must be synchronized; EPUB downloads receive a new immutable object key.
When settings change, the server updates Canonical Items/datasets, the HF mirror,
Delivery manifests/indexes/catalog and canonical compressed sizes before uploading.
It stages all changed metadata and rolls back on write errors; chapter bodies, media,
EPUB exports and search text are unchanged. Existing HF snapshot caches invalidate
when the mirror changes. Previously uploaded targets must be included in a settings change.
Each target records the settings actually uploaded and its completion timestamp;
failed attempts retain the last successful result. Retries do not rebuild the source.
Book publication initializes `HF_HUB_DISABLE_XET=1` before the Hub's first import,
including the configuration endpoint's cached-login lookup, to use HTTP/LFS on
proxies where Xet transfers stall. Set it to `0` to opt into Xet and restart the
admin server after changing transport options.
The result UI distinguishes upload success from draft/public visibility, and restores
the selected job and step through `/content?job=<job_id>&step=<1..4>`.
Book publishing automatically appends an `elasticsearch` stage after HF/B2. It reads only this job's items from the immutable HF commit and reuses `es_sync.py` mapping validation and append-only deduplication.
Use `ES_SYNC_INDEX` or the existing `ES_CONTENT_INDEX`; the current Kibana connection is reused.
Local configuration uses the shared tools loader (process environment, worktree `.env.local`/`.env`, then the primary checkout, without overwriting existing values or copying credentials). Restart after changing configuration. Both HF and B2 must have completed before ES runs. Index failure preserves their successful results and can be retried with `targets: ["elasticsearch"]`. Drafts do not add documents. Existing indexed drafts are excluded through the active catalog search scope; content conflicts require the ES repair workflow.
Book search documents and new book repairs omit `metadata.access` and `metadata.librarySource`: HF/Delivery catalog settings determine visibility. Existing ES documents may retain these legacy fields; duplicate detection ignores only those two fields for books, including active repair revisions. Changing either setting reuses the indexed content without writing a duplicate. Titles, body text and other metadata still participate in conflict detection; no ES mapping change or reindex is needed.
Both import routes require an explicit `librarySource` (`jojo` or `community`), sent as a multipart form field or JSON field respectively. Missing or invalid choices return HTTP 400 before saving uploads or starting a job. The selected value is persisted in the job and passed to the pipeline's required `--library-source` option. File format never determines the library source. Choosing `community` enforces authenticated access; `jojo` retains the requested access. Publication and title changes preserve the stored canonical source, without inferring it from EPUB provenance. Legacy missing fields still mean JOJO.
See the [management workflow](../README.md) and
[Content Pipeline reference](../../content-pipeline/README.md) for supported formats,
validation rules, and the separate publication step. PDF book conversion uses external
tools; the `/pdf` publication workflow is independent of the removed Press feature.

## RMRB missing-content review

The `/rmrb-review` React route rebuilds its queue from the compact missing-row
index derived from Hugging Face Canonical and keeps Accept/Reject drafts local until the
operator explicitly publishes. `RMRB_REVIEW_ROOT` optionally changes the
directory used for the disposable SQLite cache and unpublished draft journal;
it defaults to `tmp/rmrb-review`. The cache is keyed by the HF commit and can be
deleted or rebuilt on another computer without copying any historical local
source files. The review queue only needs article keys, titles, and synthesized
PeopleData links; it does not load or expose local PDFs. These
endpoints never update Elasticsearch. The top-right publish action updates both
Hugging Face and B2 in one operation; local decision logs are not uploaded.
Accepted rows enter a local pending-publication journal. Each successful target
is cleared independently, and a row leaves the pending count only after both HF
Canonical and B2 Delivery have succeeded.
Hugging Face uses `RMRB_REVIEW_HF_REPO` (then
`HF_DATASET_REPO`) and the CLI token or `HF_TOKEN`; B2 uses
`RMRB_REVIEW_B2_REMOTE` (then `JOJO_DELIVERY_REMOTE`) through rclone.
Hugging Face publication patches only affected Canonical Items, annual article
shards, the missing-row index, and availability metadata in one commit. B2 publication writes new
immutable article fragments before mutable issue manifests and the collection
index. Rejection is reserved for confirmed invalid, duplicate, or non-article
catalog entries; after publication it is represented by the formal HF
`rejected` article status and excluded from future review queues.

## ES repair

Run `python app.py`, then open `http://127.0.0.1:5000/` for the admin console
overview. PDF intake lives at `/pdf`, and ES repair lives at `/es` (the old
`/es-repair` URL redirects in the React router).
The ES page
reads `KIBANA_URL`, `ELASTICSEARCH_USERNAME`, and `ELASTICSEARCH_PASSWORD` from
the repository root `.env`. `ES_REPAIR_INDEX` is required and has no default,
so opening the workbench can never silently target either a test or production
index.
The local client defaults `ES_VERIFY_TLS` to `false` because Tencent's public
Kibana `:5601` endpoint may terminate verified TLS handshakes; set it to `true`
when the endpoint certificate path works in your environment.

Repairs and removals first create a deterministic JSON migration in
`es_migrations/`, then use append-only `_create`: a repair appends a complete
new version and a removal appends a tombstone. Search builds its excluded ID
set from applied migrations instead of scanning ES revision documents. Reader
Search does not receive those migration files. After ES accepts a repair, the
workbench automatically merges its applied exclusions into the single private
COS object `runtime/search/search-state.json`. It reads the remote object first
and takes a per-index union, so a second computer with no local migration
history cannot erase earlier repairs. A failed COS publication is reported as
a partial success and can be retried through
`POST /api/es-repair/publish-state` without appending another ES revision.
Set `SEARCH_STATE_INDICES` to the comma-separated indexes actually served by
SCF. A repair index outside that allow-list is rejected before ES is written;
this prevents test indexes from entering the production search state.
The Canonical synchronizer resolves the same applied migration chain before it
compares a stable ID, so an already-repaired document is compared with its
current repair rather than repeatedly conflicting with the original version.
Operator-only fields such as the
repair reason remain in the migration file and are not indexed in ES. Existing
documents are never physically overwritten.

## Unified ES sync

`es_sync.py` reads the public Hugging Face Canonical Dataset directly. It does
not read local JSONL, PDFs, or a B2 Delivery mirror. Books are indexed one
document per chapter; newspaper and Times content are indexed one document per
article. Every document has the same small business shape:

```json
{
  "type": "book | newspaper | news",
  "datasetId": "filterable Dataset identity",
  "itemId": "filterable book volume, newspaper issue, or news article identity",
  "title": "search result title",
  "content": "plain searchable text",
  "date": "optional ISO date or timestamp",
  "source": "book, newspaper, or publisher name",
  "metadata": { "type-specific navigation fields": "stored here" }
}
```

Tencent Serverless also requires `@timestamp`. Search only queries `title` and
`content`; `metadata` is returned for navigation and is not included in search
queries. The target must be created from `es_mapping.json` before any document
is written. That contract contains only `@timestamp` plus the eight business
fields above, uses `dynamic: strict`, and stores `metadata` with
`enabled: false`. The synchronizer validates the complete mapping and refuses
an index with missing fields, dynamic text identity fields, indexed metadata,
or any legacy fields; it never tries to repair a polluted mapping in place.

Print the exact mapping for the Tencent console:

```powershell
python tools/jojo-admin/server/es_sync.py --print-mapping
```

Elasticsearch cannot remove mapped fields. An index previously used for chunk,
vector, release, or repair experiments must be replaced with a clean index; it
must not be reused for the formal import.

Preview one real document of every type without writing ES:

```powershell
python tools/jojo-admin/server/es_sync.py `
  --types book newspaper news `
  --publication rmrb `
  --news-source ap `
  --limit-per-type 1 `
  --dry-run
```

Write the same three-document smoke test to the configured test index:

```powershell
python tools/jojo-admin/server/es_sync.py `
  --index <test-index> `
  --types book newspaper news `
  --publication rmrb `
  --news-source ap `
  --limit-per-type 1
```

For a full initial load, use a newly created empty Serverless index and omit
`--limit-per-type`. Re-running the same command is the incremental path: stable
IDs are written with `_create`, identical rows are counted as unchanged, and a
changed Canonical row stops as a conflict instead of silently leaving two live
versions. Apply such corrections with the existing append-only repair page.
`--since YYYY-MM-DD` and `--until YYYY-MM-DD` limit Times date indexes; repeat
`--news-source` or `--publication` to select sources.

## Storage Backends

Storage is configured in `config.json` under `storage.backends`. Publications
only point at a backend name, so moving from OneDrive to R2 no longer requires
Python code changes.

```json
{
  "storage": {
    "default_backend": "reader_r2",
    "backends": {
      "reader_r2": {
        "type": "rclone",
        "remote": "jojo-r2:reader-pdfs",
        "processed_prefix": "{code}",
        "split_prefix": "internal/{code}",
        "manifest_prefix": "manifests",
        "upload_workers": 4,
        "immutable": true,
        "retries": 5,
        "low_level_retries": 10,
        "rclone_args": ["--s3-no-check-bucket"],
        "upload_headers": {
          "Content-Type": "application/pdf",
          "Cache-Control": "public, max-age=31536000, immutable"
        }
      }
    }
  }
}
```

For Cloudflare R2, create an rclone remote first, then set `remote` to
`<remote-name>:<bucket-or-prefix>`.

```bash
rclone config
```

`immutable: true` and the final existence check prevent accidental overwrites.
`upload_workers`, `retries`, and `low_level_retries` control commit concurrency
and retry behavior.

The legacy OneDrive layout still works through a local backend:

```json
{
  "type": "local",
  "root": "D:\\Cloud\\OneDrive - JOJOKanBao Tech",
  "processed_prefix": "{code}",
  "split_prefix": "internal/{code}"
}
```

## Object Layout

For publication `RMRB`, the default layout is:

```text
RMRB/1946/19460515.pdf
internal/RMRB/19460515-1.pdf
internal/RMRB/19460515-2.pdf
manifests/RMRB.json
```

`processed_prefix` and `split_prefix` support `{code}` and `{code_lower}`.

## Health Checks

The web app exposes:

```text
GET /api/config/validate
GET /api/storage/health
GET /api/storage/health?write=1
```

`write=1` performs a small write/delete probe against each configured backend.
The UI runs this once on startup, then uses read-only checks.

## Commit Flow

The commit step is asynchronous. After preprocessing, clicking confirm starts an
upload task and streams progress over `/api/progress/<task_id>`. On success the
tool writes `manifests/{code}.json`, cleans the staging directory, then opens the
Vue review step. On failure the staging directory is kept for retry or manual
inspection.
