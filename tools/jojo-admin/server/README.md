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
the repository root `.env`. It uses `aitest-1tk2lxru` by default; set
`ES_REPAIR_INDEX` to override it.
The local client defaults `ES_VERIFY_TLS` to `false` because Tencent's public
Kibana `:5601` endpoint may terminate verified TLS handshakes; set it to `true`
when the endpoint certificate path works in your environment.

Repairs and removals first create a deterministic JSON migration in
`es_migrations/`, then use append-only `_create`: a repair appends a complete
new version and a removal appends a tombstone. Search builds its excluded ID
set from applied migrations instead of scanning ES revision documents. Reader
Search does not receive those migration files. Run
`publish_search_state.py --bucket <bucket> --region <region>` after applying a
repair to replace the single `runtime/search/search-state.json` COS snapshot.
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
queries. A Console-created index may disable metadata indexing. Existing
Serverless data streams reject `PUT _mapping`, so the synchronizer accepts their
bounded dynamic metadata fields and reports that limitation.

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
  --index aitest-1tk2lxru `
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
