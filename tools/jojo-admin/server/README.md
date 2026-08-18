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

The `/rmrb-review` React route uses the staging-only `/api/rmrb-review/*`
endpoints. Set `RMRB_REVIEW_ROOT` when the queue and decision JSONL files are
not below the repository `tmp/rmrb-peopledata-full-directory` directory. Set
`RMRB_SOURCE_PDF_ROOT` to expose matching local source PDFs through the review
link. These endpoints never write the source corpus or Elasticsearch.

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
set from applied migrations instead of scanning ES revision documents.
Operator-only fields such as the
repair reason remain in the migration file and are not indexed in ES. Existing
documents are never physically overwritten.

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
